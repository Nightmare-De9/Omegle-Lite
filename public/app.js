// public/app.js
const $ = (id) => document.getElementById(id);
const status = (s) => { $("status").textContent = s; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let WS = null;
let ME = { id: null };
let PARTNER_ID = null;
let MODE = null;
let ROOM = null;

let pc = null; // RTCPeerConnection
let localStream = null;

function interestsValue() {
  return $("interests").value.split(',').map(x => x.trim()).filter(Boolean);
}

function connectWS() {
  if (WS && WS.readyState === WebSocket.OPEN) return;
  WS = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);

  WS.onopen = () => status('Connected. Choose a mode to start.');
  WS.onclose = () => status('Disconnected. Refresh to retry.');

  WS.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { console.warn('Invalid WS message', ev.data); return; }

    if (msg.event === 'hello') {
      ME.id = msg.id;
    } else if (msg.event === 'queued') {
      status('Searching for a stranger…');
    } else if (msg.event === 'paired') {
      ROOM = msg.room_id;
      MODE = msg.mode;
      PARTNER_ID = msg.partner_id;
      status('Paired! Say hi 👋');
      if (MODE === 'text') {
        showPane('text');
      } else if (MODE === 'video') {
        showPane('video');
        // start the WebRTC flow (one side will create offer)
        await startVideoFlow();
      }
    } else if (msg.event === 'text') {
      pushMsg(msg.from === ME.id ? 'me' : 'them', msg.body);
    } else if (msg.event === 'partner_left') {
      status('Partner left. Click Next to find another.');
      PARTNER_ID = null;
      ROOM = null;
      if (MODE === 'video') stopVideo();
      showPane(''); // hide panes
    } else if (msg.event === 'signal') {
      // msg.data contains the signaling payload
      await handleSignal(msg.data);
    } else if (msg.event === 'unqueued') {
      status('Cancelled search.');
    } else {
      console.log('ws event', msg);
    }
  };
}

function showPane(which) {
  $("textPane").classList.toggle('hidden', which !== 'text');
  $("videoPane").classList.toggle('hidden', which !== 'video');
}

// Text chat UI
function pushMsg(who, body) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${who}`;
  wrap.textContent = body;
  const m = $("messages");
  m.appendChild(wrap);
  m.scrollTop = m.scrollHeight;
}

$("sendBtn").onclick = () => {
  const body = $("msgInput").value.trim();
  if (!body || !WS || WS.readyState !== WebSocket.OPEN) return;
  $("msgInput").value = '';
  WS.send(JSON.stringify({ cmd: 'text', body }));
  pushMsg('me', body);
};

// Match buttons
$("textBtn").onclick = () => { MODE = 'text'; showPane('text'); match(); };
$("videoBtn").onclick = async () => { MODE = 'video'; showPane('video'); match(); };
$("nextBtn").onclick = () => {
  if (WS && WS.readyState === WebSocket.OPEN) {
    WS.send(JSON.stringify({ cmd: 'leave', reason: 'next' }));
  }
  status('Searching for a new partner…');
  if (MODE === 'video') stopVideo();
};

function match() {
  connectWS();
  const interests = interestsValue();
  if (!WS || WS.readyState !== WebSocket.OPEN) {
    // wait briefly if socket is still opening
    const waiter = setInterval(() => {
      if (WS && WS.readyState === WebSocket.OPEN) {
        clearInterval(waiter);
        WS.send(JSON.stringify({ cmd: 'match', mode: MODE, interests }));
      }
    }, 100);
  } else {
    WS.send(JSON.stringify({ cmd: 'match', mode: MODE, interests }));
  }
}

// ---------------- WebRTC (Video) ----------------
// ICE servers: STUN by default. Add TURN servers here for NAT reliability.
const ICE_CONFIG = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302'] }
    // Example TURN entry (replace with real creds if available):
    // { urls: ['turn:your.turn.server:3478'], username: 'user', credential: 'pass' }
  ]
};

async function startVideoFlow() {
  // getMedia - prompt user for permissions
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    status('Could not get camera/microphone: ' + err.message);
    console.error(err);
    return;
  }

  $("localVideo").srcObject = localStream;

  createPeerConnection();

  // add local tracks
  for (const track of localStream.getTracks()) {
    pc.addTrack(track, localStream);
  }

  // Determine offerer role: use lexicographic id ordering to pick one deterministically
  // If partner id is missing for some reason, default to offering (works in most small demos)
  const isOfferer = (ME.id && PARTNER_ID) ? (ME.id < PARTNER_ID) : true;

  if (isOfferer) {
    try {
      const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
      await pc.setLocalDescription(offer);
      // send full SDP (sdp string) — server will relay to the partner
      WS.send(JSON.stringify({ cmd: 'signal', data: { type: 'offer', sdp: offer.sdp } }));
    } catch (err) {
      console.error('Failed to create/send offer', err);
    }
  }
}

function createPeerConnection() {
  if (pc) return; // already created
  pc = new RTCPeerConnection(ICE_CONFIG);

  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      // send candidate to partner
      WS.send(JSON.stringify({ cmd: 'signal', data: { type: 'candidate', candidate: ev.candidate } }));
    }
  };

  pc.ontrack = (ev) => {
    // remote streams can come in as ev.streams[0]
    if (ev.streams && ev.streams[0]) {
      $("remoteVideo").srcObject = ev.streams[0];
    } else {
      // fallback: build stream from tracks
      const remoteStream = new MediaStream();
      remoteStream.addTrack(ev.track);
      $("remoteVideo").srcObject = remoteStream;
    }
  };

  pc.onconnectionstatechange = () => {
    console.log('pc state:', pc.connectionState);
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      status('Connection problem. You can click Next to try again.');
    }
  };
}

async function handleSignal(data) {
  if (!data || typeof data.type !== 'string') return;
  // ensure peer connection exists for non-offer messages
  if (!pc && data.type !== 'offer') {
    // create pc and attach local media if we have it; otherwise startVideoFlow will acquire media
    createPeerConnection();
    if (!localStream) {
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        $("localVideo").srcObject = localStream;
        for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
      } catch (e) {
        console.warn('Could not acquire media when handling signal:', e);
      }
    }
  }

  try {
    if (data.type === 'offer') {
      // Remote offered an SDP
      if (!pc) createPeerConnection();
      await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
      // create answer
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      WS.send(JSON.stringify({ cmd: 'signal', data: { type: 'answer', sdp: answer.sdp } }));
    } else if (data.type === 'answer') {
      // Remote answered our offer
      await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
    } else if (data.type === 'candidate' && data.candidate) {
      // ICE candidate (object). Wrap with RTCIceCandidate if needed.
      try {
        await pc.addIceCandidate(data.candidate);
      } catch (err) {
        console.warn('addIceCandidate failed', err);
      }
    }
  } catch (err) {
    console.error('Error handling signal', err);
  }
}

function stopVideo() {
  try {
    if (pc) {
      pc.ontrack = null;
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      pc.close();
      pc = null;
    }
  } catch (e) { /* ignore */ }

  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  $("localVideo").srcObject = null;
  $("remoteVideo").srcObject = null;
  PARTNER_ID = null;
  ROOM = null;
}

// init
connectWS();
status('Connecting…');
