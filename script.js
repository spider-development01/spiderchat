import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// --- State ---
let currentUser = null;
let currentChatPartner = null;
let peerConnection = null;
let localStream = null;
let remoteStream = null;
let signalingChannel = null;

// --- Assets ---
const audioMsg = new Audio('message.mp3');
const audioCall = new Audio('call.mp3');
audioCall.loop = true;

// --- WebRTC Config ---
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' } // Free Google STUN server
    ]
};

// --- DOM Elements ---
const views = {
    auth: document.getElementById('auth-screen'),
    app: document.getElementById('app-container'),
    call: document.getElementById('call-modal')
};

// --- Initialization ---
window.onload = () => {
    checkSession();
    startClock();
};

// --- Auth Functions ---
window.handleLogin = async () => {
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) alert('Error: ' + error.message);
    else window.location.reload();
};

window.handleSignUp = async () => {
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const username = document.getElementById('username').value;
    
    if(!username) return alert("Username required for signup");

    const { data, error } = await supabase.auth.signUp({
        email, password, options: { data: { username } }
    });
    
    if (error) alert('Error: ' + error.message);
    else alert('Check your email for confirmation!');
};

window.handleLogout = async () => {
    await supabase.auth.signOut();
    window.location.reload();
};

async function checkSession() {
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
        currentUser = session.user;
        document.getElementById('my-username').innerText = 'USER: ' + (session.user.user_metadata.username || 'N/A').toUpperCase();
        views.auth.classList.add('hidden');
        views.app.classList.remove('hidden');
        initApp();
    }
}

// --- App Logic ---
async function initApp() {
    loadUsers();
    setupRealtime();
    setupSignaling();
}

async function loadUsers() {
    // In a real app, only show other users. For now, fetch all profiles.
    const { data: profiles } = await supabase.from('profiles').select('*').neq('id', currentUser.id);
    const list = document.getElementById('user-list');
    list.innerHTML = '';
    
    profiles.forEach(p => {
        const li = document.createElement('li');
        li.innerText = `> ${p.username}`;
        li.onclick = () => selectUser(p);
        list.appendChild(li);
    });
}

function selectUser(user) {
    currentChatPartner = user;
    document.getElementById('chat-with').innerText = `CONNECTED TO: ${user.username.toUpperCase()}`;
    document.querySelectorAll('#user-list li').forEach(l => l.classList.remove('active'));
    event.target.classList.add('active');
    
    document.getElementById('msg-input').disabled = false;
    document.getElementById('send-btn').disabled = false;
    document.getElementById('call-controls').classList.remove('hidden');
    
    loadMessages();
}

// --- Messaging ---
async function loadMessages() {
    const { data: msgs } = await supabase
        .from('messages')
        .select('*')
        .or(`and(sender_id.eq.${currentUser.id},receiver_id.eq.${currentChatPartner.id}),and(sender_id.eq.${currentChatPartner.id},receiver_id.eq.${currentUser.id})`)
        .order('created_at', { ascending: true });

    const area = document.getElementById('messages-area');
    area.innerHTML = '';
    msgs.forEach(displayMessage);
    area.scrollTop = area.scrollHeight;
}

window.sendMessage = async () => {
    const input = document.getElementById('msg-input');
    const content = input.value;
    if (!content) return;

    await supabase.from('messages').insert({
        sender_id: currentUser.id,
        receiver_id: currentChatPartner.id,
        content: content
    });

    input.value = '';
};

function displayMessage(msg) {
    const area = document.getElementById('messages-area');
    const div = document.createElement('div');
    const isMe = msg.sender_id === currentUser.id;
    div.className = `msg ${isMe ? 'sent' : 'received'}`;
    div.innerText = msg.content;
    area.appendChild(div);
    area.scrollTop = area.scrollHeight;
}

// --- Realtime (Chat) ---
function setupRealtime() {
    supabase.channel('public:messages')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, payload => {
            const msg = payload.new;
            // If the message is relevant to the current conversation
            if (currentChatPartner && 
               ((msg.sender_id === currentChatPartner.id && msg.receiver_id === currentUser.id) ||
                (msg.sender_id === currentUser.id && msg.receiver_id === currentChatPartner.id))) {
                displayMessage(msg);
            }
            // Sound notification for incoming
            if (msg.receiver_id === currentUser.id) {
                audioMsg.play().catch(e => console.log("Audio interaction needed"));
            }
        })
        .subscribe();
}

// --- WebRTC Signaling (Supabase Realtime) ---
function setupSignaling() {
    // Listen to a channel specifically for ME
    signalingChannel = supabase.channel(`calls:${currentUser.id}`)
        .on('broadcast', { event: 'signal' }, async ({ payload }) => {
            handleSignal(payload);
        })
        .subscribe();
}

async function sendSignal(type, data, targetUserId) {
    // Send signal to the target's channel
    await supabase.channel(`calls:${targetUserId}`).send({
        type: 'broadcast',
        event: 'signal',
        payload: { type, data, from: currentUser.id, username: currentUser.user_metadata.username }
    });
}

// --- Call Logic ---
window.startCall = async (type) => { // type = 'audio' or 'video'
    views.call.classList.remove('hidden');
    document.getElementById('call-status').innerText = `DIALING ${currentChatPartner.username.toUpperCase()}...`;
    
    // Init Peer Connection
    createPeerConnection();
    
    // Get Local Stream
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ 
            audio: true, 
            video: type === 'video' 
        });
        document.getElementById('local-video').srcObject = localStream;
        localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
        
        // Create Offer
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        
        // Send Offer
        sendSignal('offer', offer, currentChatPartner.id);
    } catch (err) {
        console.error("Media Error:", err);
        alert("Microphone/Camera access denied.");
        endCall();
    }
};

async function handleSignal(payload) {
    const { type, data, from, username } = payload;
    
    if (type === 'offer') {
        // Incoming Call
        currentChatPartner = { id: from, username: username }; // Set context
        views.call.classList.remove('hidden');
        document.getElementById('call-status').innerText = `INCOMING SIGNAL FROM ${username.toUpperCase()}`;
        document.getElementById('accept-btn').classList.remove('hidden');
        document.getElementById('accept-btn').onclick = () => acceptCall(data);
        
        audioCall.play(); // Ringtone
    } 
    else if (type === 'answer') {
        if (peerConnection) {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data));
            document.getElementById('call-status').innerText = "CONNECTION ESTABLISHED";
        }
    } 
    else if (type === 'ice-candidate') {
        if (peerConnection) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(data));
        }
    }
    else if (type === 'end-call') {
        endCallUI();
    }
}

async function acceptCall(offer) {
    audioCall.pause();
    document.getElementById('accept-btn').classList.add('hidden');
    document.getElementById('call-status').innerText = "CONNECTING...";
    
    createPeerConnection();
    
    // Get Stream
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    document.getElementById('local-video').srcObject = localStream;
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
    
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    
    sendSignal('answer', answer, currentChatPartner.id);
}

function createPeerConnection() {
    peerConnection = new RTCPeerConnection(rtcConfig);
    
    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            sendSignal('ice-candidate', event.candidate, currentChatPartner.id);
        }
    };
    
    peerConnection.ontrack = (event) => {
        document.getElementById('remote-video').srcObject = event.streams[0];
    };
}

window.endCall = () => {
    if (currentChatPartner) {
        sendSignal('end-call', {}, currentChatPartner.id);
    }
    endCallUI();
};

function endCallUI() {
    views.call.classList.add('hidden');
    audioCall.pause();
    audioCall.currentTime = 0;
    
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    if (peerConnection) peerConnection.close();
    
    localStream = null;
    peerConnection = null;
}

// --- Widgets ---
function startClock() {
    setInterval(() => {
        const now = new Date();
        document.getElementById('clock').innerText = now.toLocaleTimeString();
        document.getElementById('date').innerText = now.toISOString().split('T')[0];
    }, 1000);
}
