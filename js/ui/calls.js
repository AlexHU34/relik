/* Relik — голосовые и видеозвонки 1-на-1 (WebRTC + Supabase Broadcast) */
import { S, chatById } from './state.js';
import { $, avatarHtml } from './utils.js';
import { icon } from './icons.js';
import { t } from '../i18n/i18n.js';
import { toast } from './toast.js';
import { startRing, stopRing, playTest } from './sounds.js';
import { SUPABASE } from '../config.js';
import { initCallSignaling, stopCallSignaling, sendCallSignal } from '../backend/calls.js';

const ICE = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
  ],
};

let state = 'idle';           // idle | out | in | connecting | active
let pc = null;
let localStream = null;
let screenStream = null;
let videoSender = null;
let peerId = null;
let chatId = null;
let callId = null;
let offerSdp = null;
let pendingIce = [];
let timerId = null;
let connectedAt = 0;
let ringTimeout = null;
let muted = false;
let cameraOff = false;
let sharedScreen = false;
let wantVideo = false;
let uiBound = false;
let peerInfo = null;

const me = () => ({ id: S.me?.id, name: S.me?.name, avatar: S.me?.avatar, hue: S.me?.hue });

/* ── инициализация ─────────────────────────────────────────── */
export function initCalls() {
  if (!uiBound) {
    setIcons();
    $('#callEnd').addEventListener('click', () => endCall(true));
    $('#callAccept').addEventListener('click', acceptCall);
    $('#callDecline').addEventListener('click', declineCall);
    $('#callMute').addEventListener('click', toggleMute);
    $('#callCamera').addEventListener('click', toggleCamera);
    $('#callScreen').addEventListener('click', toggleScreenShare);
    uiBound = true;
  }
  if (S.me && SUPABASE.url && SUPABASE.anonKey) {
    initCallSignaling(S.me, onSignal);
  }
}

function setIcons() {
  $('#callMute').innerHTML = icon('mic', 22);
  $('#callEnd').innerHTML = icon('phoneOff', 22);
  $('#callAccept').innerHTML = icon('phone', 22);
  $('#callDecline').innerHTML = icon('x', 22);
  $('#callCamera').innerHTML = icon('video', 22);
  $('#callScreen').innerHTML = icon('screen', 22);
}

export function stopCalls() {
  stopCallSignaling();
  if (state !== 'idle') endCall(true);
}

/* ── исходящий звонок ─────────────────────────────────────── */
export async function startCall(chat, opts = {}) {
  if (!chat) return;
  if (chat.kind !== 'dm') { toast(t('call.groupSoon')); return; }
  if (!SUPABASE.url || !SUPABASE.anonKey) { toast(t('call.requiresBackend')); return; }
  if (state !== 'idle') { toast(t('call.already')); return; }

  const u = S.users.find((x) => x.id === chat.userId) || { name: chat.title, hue: chat.hue ?? 0 };
  peerInfo = { id: chat.userId, name: u.name, hue: u.hue, avatar: u.avatar };
  peerId = chat.userId;
  chatId = chat.id;
  callId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
  state = 'out';
  muted = false;
  cameraOff = false;
  sharedScreen = false;
  wantVideo = !!opts.video;

  showOverlay(peerInfo, 'out', wantVideo);
  setStatus(wantVideo ? t('call.videoCalling') : t('call.calling'));
  startRing();

  try {
    pc = createPc();
    await attachMedia(pc, wantVideo);
    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: wantVideo });
    await pc.setLocalDescription(offer);
    await sendCallSignal(peerId, {
      type: 'offer', callId, chatId, video: wantVideo, from: me(), sdp: pc.localDescription,
    });
    ringTimeout = setTimeout(() => {
      if (state === 'out') endCall(true, t('call.noAnswer'));
    }, 30000);
  } catch (err) {
    console.error('Call start error:', err);
    endCall(false, t(wantVideo ? 'call.cameraDenied' : 'call.micDenied'));
  }
}

/* ── входящий ─────────────────────────────────────────────── */
function onSignal(payload) {
  if (!payload || !payload.from || payload.from.id === S.me?.id) return;

  switch (payload.type) {
    case 'offer':
      if (state !== 'idle') {
        sendCallSignal(payload.from.id, { type: 'busy', callId: payload.callId, from: me() });
        return;
      }
      state = 'in';
      peerId = payload.from.id;
      chatId = payload.chatId;
      callId = payload.callId;
      offerSdp = payload.sdp;
      peerInfo = payload.from;
      muted = false;
      cameraOff = false;
      sharedScreen = false;
      wantVideo = !!payload.video;
      showOverlay(peerInfo, 'in', wantVideo);
      setStatus(wantVideo ? t('call.incomingVideo') : t('call.incoming'));
      startRing();
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
      break;

    case 'answer':
      if (state !== 'out' || !pc || payload.callId !== callId) return;
      pc.setRemoteDescription(payload.sdp)
        .then(flushIce)
        .catch((err) => { console.error('answer error', err); endCall(true, t('call.error')); });
      break;

    case 'ice':
      if (payload.callId !== callId) return;
      if (pc && pc.remoteDescription) pc.addIceCandidate(payload.candidate).catch(() => {});
      else pendingIce.push(payload.candidate);
      break;

    case 'decline':
      if (payload.callId !== callId) return;
      endCall(false);
      toast(t('call.declined'));
      break;

    case 'busy':
      if (payload.callId !== callId) return;
      endCall(false);
      toast(t('call.busy'));
      break;

    case 'end':
      if (payload.callId !== callId) return;
      endCall(false, t('call.ended'));
      break;
  }
}

function flushIce() {
  if (!pc) return;
  for (const c of pendingIce) pc.addIceCandidate(c).catch(() => {});
  pendingIce = [];
}

/* ── принятие / отклонение ────────────────────────────────── */
async function acceptCall() {
  if (state !== 'in') return;
  stopRing();
  state = 'connecting';
  showActiveControls();
  setStatus(t('call.connecting'));

  try {
    pc = createPc();
    await attachMedia(pc, wantVideo);
    await pc.setRemoteDescription(offerSdp);
    flushIce();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await sendCallSignal(peerId, { type: 'answer', callId, video: wantVideo, from: me(), sdp: pc.localDescription });
  } catch (err) {
    console.error('Accept error:', err);
    endCall(true, t('call.error'));
  }
}

function declineCall() {
  if (state !== 'in') return;
  sendCallSignal(peerId, { type: 'decline', callId, from: me() });
  endCall(false);
}

/* ── WebRTC ───────────────────────────────────────────────── */
function createPc() {
  const conn = new RTCPeerConnection(ICE);

  conn.onicecandidate = (e) => {
    if (e.candidate && peerId) {
      sendCallSignal(peerId, { type: 'ice', callId, from: me(), candidate: e.candidate });
    }
  };

  conn.ontrack = (e) => {
    const remoteAudio = $('#remoteAudio');
    if (remoteAudio) { remoteAudio.srcObject = e.streams[0]; remoteAudio.play().catch(() => {}); }
    const remoteVideo = $('#remoteVideo');
    if (remoteVideo && e.track.kind === 'video') {
      remoteVideo.srcObject = e.streams[0];
      remoteVideo.play().catch(() => {});
      $('#callOverlay').classList.add('has-remote-video');
    }
  };

  conn.onconnectionstatechange = () => {
    const s = conn.connectionState;
    if (s === 'connected') markConnected();
    else if (s === 'failed') endCall(true, t('call.failed'));
    else if (s === 'disconnected') {
      setTimeout(() => {
        if (pc && pc.connectionState === 'disconnected') endCall(true, t('call.failed'));
      }, 5000);
    }
  };

  return conn;
}

async function attachMedia(conn, withVideo) {
  localStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: withVideo ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } : false,
  });
  localStream.getTracks().forEach((track) => {
    const sender = conn.addTrack(track, localStream);
    if (track.kind === 'video') videoSender = sender;
  });
  const localVideo = $('#localVideo');
  if (localVideo && withVideo) {
    localVideo.srcObject = localStream;
    localVideo.play().catch(() => {});
  }
}

function markConnected() {
  if (state === 'active') return;
  state = 'active';
  stopRing();
  clearTimeout(ringTimeout);
  playTest();
  setStatus(t('call.connected'));
  connectedAt = Date.now();
  tickTimer();
  timerId = setInterval(tickTimer, 1000);
  showActiveControls();
  $('#callOverlay').classList.toggle('video', wantVideo);
}

/* ── кнопки во время звонка ───────────────────────────────── */
function toggleMute() {
  if (!localStream) return;
  muted = !muted;
  localStream.getAudioTracks().forEach((track) => { track.enabled = !muted; });
  const btn = $('#callMute');
  btn.classList.toggle('off', muted);
  btn.innerHTML = icon(muted ? 'micOff' : 'mic', 22);
}

function toggleCamera() {
  if (!localStream) return;
  const videoTrack = localStream.getVideoTracks()[0];
  if (!videoTrack) { toast(t('call.noCamera')); return; }
  cameraOff = !cameraOff;
  videoTrack.enabled = !cameraOff;
  const btn = $('#callCamera');
  btn.classList.toggle('off', cameraOff);
  btn.innerHTML = icon(cameraOff ? 'videoOff' : 'video', 22);
}

async function toggleScreenShare() {
  if (state !== 'active' || !pc) return;
  if (sharedScreen) {
    stopScreenShare();
    return;
  }
  if (!videoSender) { toast(t('call.screenInVideoOnly')); return; }
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const screenTrack = screenStream.getVideoTracks()[0];
    await videoSender.replaceTrack(screenTrack);
    const localVideo = $('#localVideo');
    if (localVideo) { localVideo.srcObject = screenStream; localVideo.play().catch(() => {}); }
    sharedScreen = true;
    $('#callScreen').classList.add('off');
    $('#callScreen').innerHTML = icon('screenOff', 22);
    screenTrack.onended = () => stopScreenShare();
  } catch (err) {
    console.warn('Screen share:', err);
  }
}

function stopScreenShare() {
  if (!sharedScreen) return;
  sharedScreen = false;
  if (screenStream) { screenStream.getTracks().forEach((t) => t.stop()); screenStream = null; }
  if (videoSender && localStream) {
    const cam = localStream.getVideoTracks()[0];
    if (cam) videoSender.replaceTrack(cam).catch(() => {});
  }
  const localVideo = $('#localVideo');
  if (localVideo && localStream) { localVideo.srcObject = localStream; localVideo.play().catch(() => {}); }
  $('#callScreen').classList.remove('off');
  $('#callScreen').innerHTML = icon('screen', 22);
}

/* ── UI ───────────────────────────────────────────────────── */
function showOverlay(info, mode, videoMode) {
  const ov = $('#callOverlay');
  const u = { name: info?.name || '…', hue: info?.hue ?? 0, avatar: info?.avatar };
  $('#callPeerAvatar').innerHTML = avatarHtml(u, { lg: true });
  $('#callPeerName').textContent = info?.name || '';
  $('#callTimer').textContent = '';
  ov.classList.toggle('incoming', mode === 'in');
  ov.classList.toggle('video', !!videoMode);
  ov.classList.remove('has-remote-video');
  ov.hidden = false;

  $('#callMute').hidden = mode === 'in';
  $('#callEnd').hidden = mode === 'in';
  $('#callCamera').hidden = mode === 'in' || !videoMode;
  $('#callScreen').hidden = mode === 'in' || !videoMode;
  $('#callAccept').hidden = mode !== 'in';
  $('#callDecline').hidden = mode !== 'in';
  $('#callMute').classList.remove('off');
  $('#callMute').innerHTML = icon('mic', 22);
}

function showActiveControls() {
  $('#callMute').hidden = false;
  $('#callEnd').hidden = false;
  $('#callCamera').hidden = !wantVideo;
  $('#callScreen').hidden = !wantVideo;
  $('#callAccept').hidden = true;
  $('#callDecline').hidden = true;
  $('#callOverlay').classList.remove('incoming');
}

function setStatus(text) {
  const el = $('#callStatus');
  if (el) el.textContent = text;
  const ov = $('#callOverlay');
  if (ov) ov.classList.toggle('ringing', state === 'out' || state === 'in');
}

function tickTimer() {
  const el = $('#callTimer');
  if (!el) return;
  const sec = Math.floor((Date.now() - connectedAt) / 1000);
  el.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

/* ── завершение ───────────────────────────────────────────── */
function endCall(notify = true, reason = '') {
  if (state === 'idle') return;

  if (notify && peerId && callId) {
    sendCallSignal(peerId, { type: 'end', callId, from: me() });
  }

  clearTimeout(ringTimeout);
  clearInterval(timerId);
  timerId = null;
  stopRing();

  if (screenStream) { screenStream.getTracks().forEach((tr) => tr.stop()); screenStream = null; }
  if (pc) { try { pc.close(); } catch (e) {} pc = null; }
  if (localStream) { localStream.getTracks().forEach((tr) => tr.stop()); localStream = null; }
  videoSender = null;

  const remoteAudio = $('#remoteAudio');
  if (remoteAudio) remoteAudio.srcObject = null;
  const remoteVideo = $('#remoteVideo');
  if (remoteVideo) remoteVideo.srcObject = null;
  const localVideo = $('#localVideo');
  if (localVideo) localVideo.srcObject = null;

  state = 'idle';
  peerId = null;
  chatId = null;
  callId = null;
  offerSdp = null;
  pendingIce = [];
  connectedAt = 0;
  muted = false;
  cameraOff = false;
  sharedScreen = false;

  const ov = $('#callOverlay');
  if (ov) {
    ov.hidden = true;
    ov.classList.remove('incoming', 'ringing', 'video', 'has-remote-video');
  }
  $('#callTimer').textContent = '';
  $('#callStatus').textContent = '';
  $('#callPeerName').textContent = '';

  if (reason) toast(reason);
}
