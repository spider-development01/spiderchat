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

// --- Constants ---
// We use a standard looking domain to trick Supabase validation
const FAKE_DOMAIN = "@rice.com"; 

// --- Auth State ---
let isLoginMode = true;

// --- Auth UI Logic (Keep this the same as before) ---
window.switchAuthMode = (mode) => {
    const status = document.getElementById('auth-status');
    const actionBtn = document.getElementById('auth-action-btn');
    const tabLogin = document.getElementById('tab-login');
    const tabRegister = document.getElementById('tab-register');

    if (mode === 'login') {
        isLoginMode = true;
        tabLogin.classList.add('active');
        tabRegister.classList.remove('active');
        actionBtn.innerHTML = ':: INITIALIZE_SESSION';
        status.innerText = "MODE: AUTHENTICATION";
        status.style.color = "var(--primary)";
    } else {
        isLoginMode = false;
        tabRegister.classList.add('active');
        tabLogin.classList.remove('active');
        actionBtn.innerHTML = ':: CREATE_NEW_NODE';
        status.innerText = "MODE: REGISTRATION";
        status.style.color = "var(--success)";
    }
};

// --- Auth Backend Logic (THE FIX) ---
window.handleAuthAction = async () => {
    const rawUsername = document.getElementById('auth-username').value;
    const password = document.getElementById('password').value;
    const status = document.getElementById('auth-status');

    // 1. Validation
    if (!rawUsername || !password) {
        status.innerText = "ERROR: FIELDS_EMPTY";
        status.style.color = "var(--danger)";
        return;
    }

    // 2. Strict Sanitization
    // Removes spaces, symbols, and converts to lowercase. 
    // "Cool Guy!" -> "coolguy"
    const cleanUsername = rawUsername.trim().toLowerCase().replace(/[^a-z0-9]/g, '');

    if (cleanUsername.length < 3) {
        status.innerText = "ERROR: USERNAME TOO SHORT (MIN 3 CHARS)";
        status.style.color = "var(--danger)";
        return;
    }

    // 3. Construct the "Internal" Email
    const email = `${cleanUsername}${FAKE_DOMAIN}`;

    status.innerText = "PROCESSING...";
    status.classList.remove('blink');

    try {
        if (isLoginMode) {
            // --- LOGIN ---
            const { data, error } = await supabase.auth.signInWithPassword({ 
                email: email, 
                password: password 
            });
            
            if (error) throw error;

            status.innerText = "ACCESS GRANTED.";
            status.style.color = "var(--success)";
            setTimeout(() => window.location.reload(), 500);

        } else {
            // --- REGISTER ---
            // Note: We save the ORIGINAL raw username (with spaces/caps) in metadata for display
            const { data, error } = await supabase.auth.signUp({
                email: email,
                password: password,
                options: { 
                    data: { username: rawUsername } 
                }
            });

            if (error) throw error;

            status.innerText = "NODE CREATED. LOGGING IN...";
            status.style.color = "var(--success)";
            
            // Wait 1.5s then reload to enter app
            setTimeout(() => window.location.reload(), 1500);
        }
    } catch (err) {
        let msg = err.message.toUpperCase();
        
        // Translate common Supabase errors to "Terminal" speak
        if(msg.includes("INVALID LOGIN")) msg = "INVALID CREDENTIALS";
        if(msg.includes("ALREADY REGISTERED")) msg = "USERNAME ALREADY TAKEN";
        if(msg.includes("VALIDATION FAILED")) msg = "INVALID CHARACTERS IN INPUT";
        
        status.innerText = `ERROR: ${msg}`;
        status.style.color = "var(--danger)";
    }
};

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
