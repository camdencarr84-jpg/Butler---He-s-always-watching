// Butler — WebRTC P2P recorder/livestream
// Uses PeerJS public broker for signaling — no backend required.

const $ = (id) => document.getElementById(id);
function logMsg(msg) {
  const el = $("log"); if (!el) return;
  const t = new Date().toLocaleTimeString();
  el.textContent = `[${t}] ${msg}\n` + el.textContent;
}
function setStatus(state, text) {
  const s = $("sigStatus"); if (!s) return;
  s.classList.remove("on","err"); if (state) s.classList.add(state);
  $("sigText").textContent = text;
}
function makeId() {
  return "butler-" + Math.random().toString(36).slice(2, 8);
}
function newPeer(id) {
  return new Peer(id, {
    debug: 1,
    config: {
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:global.stun.twilio.com:3478" }
      ]
    }
  });
}

/* ---------------- HOST ---------------- */
async function initHost() {
  let stream = null, peer = null, recorder = null, chunks = [];
  const calls = new Map(); // peerId -> MediaConnection

  async function listDevices() {
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      tmp.getTracks().forEach(t => t.stop());
    } catch(e){ logMsg("Permission needed to list devices: " + e.message); }
    const devs = await navigator.mediaDevices.enumerateDevices();
    const cams = devs.filter(d => d.kind === "videoinput");
    const mics = devs.filter(d => d.kind === "audioinput");
    $("camSel").innerHTML = cams.map(d => `<option value="${d.deviceId}">${d.label||"Camera"}</option>`).join("");
    $("micSel").innerHTML = mics.map(d => `<option value="${d.deviceId}">${d.label||"Microphone"}</option>`).join("");
  }
  await listDevices();

  async function getStream() {
    const videoId = $("camSel").value, audioId = $("micSel").value;
    return await navigator.mediaDevices.getUserMedia({
      video: videoId ? { deviceId: { exact: videoId } } : true,
      audio: audioId ? { deviceId: { exact: audioId }, echoCancellation: true } : true
    });
  }

  function renderPeers() {
    const wrap = $("peers"); wrap.innerHTML = "";
    $("vCount").textContent = calls.size;
    calls.forEach((_, id) => {
      const row = document.createElement("div");
      row.className = "peer";
      row.innerHTML = `<span>${id.slice(0,18)}</span><span class="ok">● connected</span>`;
      wrap.appendChild(row);
    });
  }

  $("goLive").onclick = async () => {
    try {
      $("goLive").disabled = true;
      setStatus(null, "Requesting camera…");
      stream = await getStream();
      $("preview").srcObject = stream;
      $("liveBadge").style.display = "flex";
      $("recBtn").disabled = false;

      const id = makeId();
      setStatus(null, "Connecting to signaling…");
      peer = newPeer(id);

      peer.on("open", (pid) => {
        const link = `${location.origin}${location.pathname.replace(/host\.html$/,"viewer.html")}?id=${pid}`;
        $("link").value = link;
        setStatus("on", "Live · " + pid);
        logMsg("Live. Share: " + link);
        $("stop").disabled = false;
      });
      peer.on("error", (err) => {
        setStatus("err", "Signaling error: " + err.type);
        logMsg("Peer error: " + err.type + " — " + err.message);
      });
      peer.on("disconnected", () => { setStatus("err", "Disconnected — reconnecting"); peer.reconnect(); });

      // Viewers open a DataConnection first; host then CALLS the viewer with the stream.
      // (Avoids the empty-MediaStream / no-transceiver bug when viewer initiates.)
      peer.on("connection", (conn) => {
        logMsg("Viewer connecting: " + conn.peer);
        conn.on("open", () => {
          if (!stream) { conn.close(); return; }
          const call = peer.call(conn.peer, stream);
          calls.set(conn.peer, call);
          renderPeers();
          call.on("close", () => { calls.delete(conn.peer); renderPeers(); logMsg("Viewer left: " + conn.peer); });
          call.on("error", (e) => { logMsg("Call error: " + e.message); calls.delete(conn.peer); renderPeers(); });
        });
        conn.on("close", () => {
          const c = calls.get(conn.peer);
          if (c) { try { c.close(); } catch(_){} calls.delete(conn.peer); renderPeers(); }
        });
      });

      // Backward-compat: if a viewer still places a media call, answer it.
      peer.on("call", (call) => {
        logMsg("Incoming call from: " + call.peer);
        call.answer(stream);
        calls.set(call.peer, call);
        renderPeers();
        call.on("close", () => { calls.delete(call.peer); renderPeers(); });
      });
    } catch (e) {
      setStatus("err", "Failed: " + e.message);
      logMsg("Error: " + e.message);
      $("goLive").disabled = false;
    }
  };

  $("stop").onclick = () => {
    calls.forEach(c => c.close()); calls.clear(); renderPeers();
    if (peer) { peer.destroy(); peer = null; }
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    $("preview").srcObject = null;
    $("liveBadge").style.display = "none";
    $("link").value = ""; setStatus(null, "Stopped");
    $("goLive").disabled = false; $("stop").disabled = true; $("recBtn").disabled = true;
  };

  $("copyBtn").onclick = async () => {
    if (!$("link").value) return;
    await navigator.clipboard.writeText($("link").value);
    $("copyBtn").textContent = "Copied!";
    setTimeout(() => $("copyBtn").textContent = "Copy", 1200);
  };

  $("recBtn").onclick = () => {
    if (!stream) return;
    chunks = [];
    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus") ? "video/webm;codecs=vp9,opus" : "video/webm";
    recorder = new MediaRecorder(stream, { mimeType: mime });
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: mime });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `butler-${Date.now()}.webm`;
      a.click();
      logMsg("Saved recording (" + (blob.size/1e6).toFixed(2) + " MB)");
    };
    recorder.start(1000);
    $("recBtn").disabled = true; $("recStop").disabled = false;
    logMsg("Recording started.");
  };
  $("recStop").onclick = () => {
    if (recorder && recorder.state !== "inactive") recorder.stop();
    $("recBtn").disabled = false; $("recStop").disabled = true;
  };
}

/* ---------------- VIEWER ---------------- */
function initViewer() {
  let peer = null, dataConn = null, currentCall = null, recorder = null, chunks = [], remoteStream = null;
  let connectTimer = null;

  const params = new URLSearchParams(location.search);
  if (params.get("id")) $("idIn").value = params.get("id");

  $("joinBtn").onclick = () => {
    const target = $("idIn").value.trim();
    if (!target) { setStatus("err","Enter a stream ID"); return; }
    setStatus(null, "Connecting to signaling…");
    $("joinBtn").disabled = true;

    peer = newPeer();
    peer.on("open", () => {
      setStatus(null, "Calling host…");
      logMsg("Calling " + target);
      // Open a data channel — host listens for "connection" and calls us back with media.
      dataConn = peer.connect(target, { reliable: true });
      dataConn.on("open", () => { logMsg("Signaling channel open — waiting for stream…"); });
      dataConn.on("error", (e) => { setStatus("err","Conn error: "+e.message); logMsg(e.message); });

      // Host calls us back with their media stream.
      peer.on("call", (call) => {
        currentCall = call;
        call.answer(); // receive-only — no local stream needed
        call.on("stream", (rs) => {
          if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
          remoteStream = rs;
          $("remote").srcObject = rs;
          $("liveBadge").style.display = "flex";
          setStatus("on", "Connected · " + target);
          logMsg("Stream received.");
          $("recBtn").disabled = false; $("leaveBtn").disabled = false;
        });
        call.on("close", () => { setStatus("err","Host ended stream"); cleanup(); });
        call.on("error", (e) => { setStatus("err","Call error: "+e.message); logMsg(e.message); cleanup(); });
      });

      // Timeout safety net
      connectTimer = setTimeout(() => {
        if (!remoteStream) {
          setStatus("err","Host did not respond — is the stream live?");
          logMsg("Timeout waiting for host stream.");
          cleanup();
        }
      }, 15000);
    });
    peer.on("error", (err) => {
      const msg = err.type === "peer-unavailable" ? "Stream not found — check the ID" : err.type;
      setStatus("err", msg); logMsg("Peer error: " + msg);
      $("joinBtn").disabled = false;
    });
  };

  function cleanup() {
    if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
    if (currentCall) { try { currentCall.close(); } catch(_){} currentCall = null; }
    if (dataConn) { try { dataConn.close(); } catch(_){} dataConn = null; }
    if (peer) { peer.destroy(); peer = null; }
    $("remote").srcObject = null; $("liveBadge").style.display = "none";
    $("joinBtn").disabled = false; $("leaveBtn").disabled = true;
    $("recBtn").disabled = true; $("recStop").disabled = true;
    remoteStream = null;
  }
  $("leaveBtn").onclick = cleanup;

  $("recBtn").onclick = () => {
    if (!remoteStream) return;
    chunks = [];
    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus") ? "video/webm;codecs=vp9,opus" : "video/webm";
    recorder = new MediaRecorder(remoteStream, { mimeType: mime });
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: mime });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `butler-viewer-${Date.now()}.webm`; a.click();
      logMsg("Saved (" + (blob.size/1e6).toFixed(2) + " MB)");
    };
    recorder.start(1000);
    $("recBtn").disabled = true; $("recStop").disabled = false;
  };
  $("recStop").onclick = () => {
    if (recorder && recorder.state !== "inactive") recorder.stop();
    $("recBtn").disabled = false; $("recStop").disabled = true;
  };
}
