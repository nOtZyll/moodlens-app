const video = document.getElementById('videoElement');
const canvas = document.getElementById('canvasElement');
const overlayCanvas = document.getElementById('overlayCanvas'); 
const btnStart = document.getElementById('btnStart');
const btnStop = document.getElementById('btnStop');
const btnMeme = document.getElementById('btnMeme'); 
const emotionResult = document.getElementById('emotionResult');
const probContainer = document.getElementById('probContainer');
const memeArea = document.getElementById('memeArea'); 
const memeCanvas = document.getElementById('memeCanvas'); 
const btnDownloadMeme = document.getElementById('btnDownloadMeme');
const btnRetake = document.getElementById('btnRetake');
const liveSection = document.getElementById('liveSection');
const videoWrapper = document.getElementById('videoWrapper');
const memeEmotion = document.getElementById('memeEmotion');
const countdownEl = document.getElementById('countdown');
const cameraFlash = document.getElementById('cameraFlash');
const photoCanvas = document.getElementById('photoCanvas');
const btnUpload = document.getElementById('btnUpload');
const photoInput = document.getElementById('photoInput');

const EMOTIONS = ['ANGRY', 'DISGUST', 'FEAR', 'HAPPY', 'NEUTRAL', 'SAD', 'SURPRISE'];
const MEME_BUTTON_LABEL = "Make Me a Meme!";
const COUNTDOWN_FROM = 3;
// Go back to the start screen after this long with no face in front of the camera and no touches
const IDLE_RESET_MS = 60000;
// Frames are scaled down before upload; the server's face box is scaled back up for the overlay
const MAX_FRAME_WIDTH = 640;
// Uploaded photos are shrunk to this longest side, which keeps big phone photos fast to show and turn into memes
const MAX_PHOTO_SIDE = 1600;

// Logos stamped on every meme, left to right. A missing file is simply skipped.
const MEME_LOGO_SOURCES = [
    '/static/images/logos/unair.png',
    '/static/images/logos/ftmm.png',
    '/static/images/logos/iris.png'
];
const memeLogos = MEME_LOGO_SOURCES.map(src => {
    const img = new Image();
    img.src = src;
    return img;
});

let videoStream = null;
let detectionInterval = null;
let requestInFlight = false;
let clientId = null;

// Bumped whenever the meme flow is reset, so a countdown that is still running knows to stop
let memeAttempt = 0;
let memeMessageTimer = null;
let lastActivity = Date.now();

// The uploaded photo (unannotated) and the emotion found in it, while the page is in photo mode
let photoSource = null;
let photoEmotion = null;
let memeFromPhoto = false;

// "Send to Phone" exists only when Drive sharing is configured on the server
const shareDialog = document.getElementById('shareDialog');
// Bumped for every new meme, so a slow upload can't attach its QR to a newer meme
let memeVersion = 0;
let sharedMeme = null;
let shareUploading = false;

async function startCamera() {
    if (videoStream) return;
    try {
        videoStream = await navigator.mediaDevices.getUserMedia({ video: true });
        video.srcObject = videoStream;
        exitPhotoMode();
        videoWrapper.classList.add('live');
        lastActivity = Date.now();
        // ID baru tiap kamera dinyalakan, supaya riwayat smoothing mulai dari awal
        clientId = Date.now().toString(36) + Math.random().toString(36).slice(2);

        btnStart.style.display = 'none';
        btnStop.style.display = 'block';
        btnMeme.style.display = 'block';
        showStatus("ANALYZING...");

        detectionInterval = setInterval(captureAndSendFrame, 1500);

    } catch (err) {
        console.error("Error accessing webcam:", err);
        alert("Gagal mengakses kamera. Pastikan browser diizinkan menggunakan kamera.\n\n" + err.name + ": " + err.message);
    }
}

function stopCamera() {
    if (videoStream) {
        videoStream.getTracks().forEach(track => track.stop());
        video.srcObject = null;
        videoStream = null;
    }
    videoWrapper.classList.remove('live');

    if (detectionInterval) {
        clearInterval(detectionInterval);
        detectionInterval = null;
    }
    resetMemeButton();

    const ctxOverlay = overlayCanvas.getContext('2d');
    ctxOverlay.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

    btnStart.style.display = 'block';
    btnStop.style.display = 'none';
    btnMeme.style.display = 'none';
    showStatus("CAMERA OFF");
}

// Once a meme is made, turn the camera off and show only the result
function showMemeResult(emotion) {
    if (videoStream) stopCamera();
    memeEmotion.innerText = emotion;
    liveSection.style.display = 'none';
    memeArea.style.display = 'block';
    memeArea.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function retakeMeme() {
    memeArea.style.display = 'none';
    liveSection.style.display = '';
    window.scrollTo({ top: 0, behavior: 'smooth' });
    // A meme from an uploaded photo goes back to that photo; a camera meme restarts the camera
    if (!(memeFromPhoto && photoSource)) startCamera();
}

// Back to the untouched page, ready for the next visitor
function resetToStart() {
    if (shareDialog && shareDialog.open) shareDialog.close();
    stopCamera();
    exitPhotoMode();
    memeArea.style.display = 'none';
    liveSection.style.display = '';
    window.scrollTo({ top: 0 });
}

const STATUS_MESSAGES = {
    'NO FACE DETECTED': 'NO FACE DETECTED',
    'INVALID CROP': 'NO FACE DETECTED',
    'MODEL NOT LOADED': 'MODEL NOT LOADED',
    'ERROR': 'ANALYSIS FAILED'
};

function showStatus(message) {
    emotionResult.innerText = message;
    emotionResult.style.color = "#94a3b8";
    emotionResult.classList.add('is-status');
    probContainer.innerHTML = '';
}

// Scales a frame down to MAX_FRAME_WIDTH and returns it as a JPEG data URL, plus the scale used
function encodeFrame(source, width, height) {
    const scale = Math.min(1, MAX_FRAME_WIDTH / width);
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
    return { image: canvas.toDataURL('image/jpeg', 0.85), scale };
}

// Only the live camera loop passes clientId, so its results are smoothed over recent frames.
// Meme snapshots and uploaded photos leave it out and get the result for that exact image.
async function analyzeFrame(image, clientId = null) {
    const response = await fetch('/analyze_frame', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ image, client_id: clientId })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

function captureAndSendFrame() {
    // Skip this tick if the previous frame is still being analyzed or the video isn't ready yet
    if (requestInFlight || !video.videoWidth) return;

    const { image, scale } = encodeFrame(video, video.videoWidth, video.videoHeight);

    requestInFlight = true;
    analyzeFrame(image, clientId)
    .then(data => {
        // The camera may have been stopped while this request was in flight
        if (!videoStream) return;

        const ctxOverlay = overlayCanvas.getContext('2d');
        overlayCanvas.width = video.videoWidth;
        overlayCanvas.height = video.videoHeight;
        ctxOverlay.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

        if (!showAnalysis(data)) return;
        drawFaceBox(ctxOverlay, data.box, scale, 5);
    })
    .catch(error => {
        console.error("Error:", error);
        if (videoStream) showStatus('CONNECTION ERROR');
    })
    .finally(() => {
        requestInFlight = false;
    });
}

function drawFaceBox(ctx, box, scale, lineWidth) {
    if (!box || box.w <= 0) return;
    ctx.strokeStyle = '#8b5cf6';
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = "round";
    ctx.strokeRect(box.x / scale, box.y / scale, box.w / scale, box.h / scale);
}

// Shows the detected emotion and the probability bars. Returns false when no emotion was found.
function showAnalysis(data) {
    if (!EMOTIONS.includes(data.emotion)) {
        showStatus(STATUS_MESSAGES[data.emotion] || 'ANALYSIS FAILED');
        return false;
    }

    // Someone is using the page, so it isn't idle
    lastActivity = Date.now();

    emotionResult.classList.remove('is-status');
    emotionResult.innerText = data.emotion;
    if(data.emotion === "HAPPY") emotionResult.style.color = "#FFD700";
    else if(data.emotion === "SAD") emotionResult.style.color = "#4169E1";
    else if(data.emotion === "ANGRY") emotionResult.style.color = "#DC143C";
    else emotionResult.style.color = "#8A2BE2";

    if (data.probabilities) {
        const colorMap = {
            'HAPPY': '#f1c40f', 'SAD': '#3498db', 'ANGRY': '#e74c3c',
            'NEUTRAL': '#9b59b6', 'FEAR': '#95a5a6', 'DISGUST': '#2ecc71', 'SURPRISE': '#1abc9c'
        };

        let probHTML = '';
        for (const [emotion, score] of Object.entries(data.probabilities)) {
            let percent = parseFloat(score).toFixed(1);
            let barColor = colorMap[emotion] || '#8A2BE2';

            probHTML += `
            <div class="prob-item">
                <div class="emotion-label">${emotion}</div>
                <div class="bar-wrapper">
                    <div class="bar-fill" style="width: ${percent}%; background: ${barColor};"></div>
                </div>
                <div class="percent-box" style="border-left: 3px solid ${barColor};">
                    ${percent}%
                </div>
            </div>`;
        }
        probContainer.innerHTML = probHTML;
    }
    return true;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function requestMeme() {
    // An uploaded photo is already analyzed, so its meme is made straight away
    if (photoSource && !videoStream) {
        memeFromPhoto = true;
        generateMeme(photoEmotion, photoSource, false);
        showMemeResult(photoEmotion);
        return;
    }
    memeFromPhoto = false;

    const attempt = ++memeAttempt;
    clearTimeout(memeMessageTimer);
    btnMeme.disabled = true;

    // Count down so visitors have time to pose
    for (let n = COUNTDOWN_FROM; n > 0; n--) {
        btnMeme.innerText = `GET READY... ${n}`;
        showCountdown(n);
        await sleep(1000);
        if (attempt !== memeAttempt) return;
    }
    hideCountdown();

    // Freeze this exact frame so the meme photo and the detected emotion always match
    const snapshot = document.createElement('canvas');
    snapshot.width = video.videoWidth;
    snapshot.height = video.videoHeight;
    snapshot.getContext('2d').drawImage(video, 0, 0);
    flashCamera();
    btnMeme.innerText = "ANALYZING...";

    try {
        const data = await analyzeFrame(encodeFrame(snapshot, snapshot.width, snapshot.height).image);
        if (attempt !== memeAttempt) return;

        if (EMOTIONS.includes(data.emotion)) {
            generateMeme(data.emotion, snapshot);
            showMemeResult(data.emotion);
        } else {
            showMemeButtonMessage("NO FACE, TRY AGAIN");
        }
    } catch (error) {
        console.error("Error:", error);
        if (attempt === memeAttempt) showMemeButtonMessage("TRY AGAIN");
    }
}

function showMemeButtonMessage(message) {
    btnMeme.innerText = message;
    btnMeme.disabled = false;
    memeMessageTimer = setTimeout(() => { btnMeme.innerText = MEME_BUTTON_LABEL; }, 2000);
}

function resetMemeButton() {
    memeAttempt++;
    clearTimeout(memeMessageTimer);
    hideCountdown();
    btnMeme.disabled = false;
    btnMeme.innerText = MEME_BUTTON_LABEL;
}

function showCountdown(n) {
    countdownEl.textContent = n;
    // Restart the pop animation for each number
    countdownEl.classList.remove('show');
    void countdownEl.offsetWidth;
    countdownEl.classList.add('show');
}

function hideCountdown() {
    countdownEl.classList.remove('show');
    countdownEl.textContent = '';
}

async function handlePhotoUpload() {
    const file = photoInput.files[0];
    // Clear the input so picking the same file again still fires a change event
    photoInput.value = '';
    if (!file) return;

    let img;
    try {
        img = await loadImage(file);
    } catch (error) {
        showStatus('INVALID IMAGE');
        return;
    }

    stopCamera();
    const scale = Math.min(1, MAX_PHOTO_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const source = document.createElement('canvas');
    source.width = Math.round(img.naturalWidth * scale);
    source.height = Math.round(img.naturalHeight * scale);
    source.getContext('2d').drawImage(img, 0, 0, source.width, source.height);

    photoSource = source;
    photoEmotion = null;
    videoWrapper.classList.add('photo-mode');
    drawPhoto(null, 1);
    showStatus('ANALYZING...');
    lastActivity = Date.now();

    try {
        const frame = encodeFrame(source, source.width, source.height);
        const data = await analyzeFrame(frame.image);
        // Another photo or the camera may have replaced this one in the meantime
        if (photoSource !== source) return;

        drawPhoto(data.box, frame.scale);
        if (showAnalysis(data)) {
            photoEmotion = data.emotion;
            btnMeme.style.display = 'block';
        }
    } catch (error) {
        console.error("Error:", error);
        if (photoSource === source) showStatus('CONNECTION ERROR');
    }
}

function loadImage(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read image')); };
        img.src = url;
    });
}

// Shows the uploaded photo with the face box drawn on top
function drawPhoto(box, scale) {
    photoCanvas.width = photoSource.width;
    photoCanvas.height = photoSource.height;
    const ctx = photoCanvas.getContext('2d');
    ctx.drawImage(photoSource, 0, 0);
    drawFaceBox(ctx, box, scale, Math.max(3, photoSource.width / 160));
}

function exitPhotoMode() {
    photoSource = null;
    photoEmotion = null;
    videoWrapper.classList.remove('photo-mode');
}

function flashCamera() {
    cameraFlash.classList.remove('flash');
    void cameraFlash.offsetWidth;
    cameraFlash.classList.add('flash');
}

const memeTexts = {
    'HAPPY': [
        { top: 'KETIKA LIHAT...', bottom: 'SALDO BERTAMBAH!' },
        { top: 'MUKA PAS TAU...', bottom: 'BESOK LIBUR PANJANG!' },
        { top: 'POV:', bottom: 'NEMU DUIT DI KANTONG LAMA!' },
        { top: 'DIKASIH INFO...', bottom: 'MAKANAN GRATIS!' },
        { top: 'PAS DOSEN BILANG...', bottom: 'KELAS HARI INI DIBATALKAN!' },
        { top: 'POV:', bottom: 'PROJECT IRIS BISA SELESAI' },
        { top: 'PAS GAJIAN...', bottom: 'LANGSUNG MERASA JADI SULTAN!' },
        { top: 'KETIKA PAKET...', bottom: 'DATANG LEBIH CEPAT DARI ESTIMASI!' },
        { top: 'PAS DENGAR...', bottom: 'ABANG BAKSO LEWAT DEPAN RUMAH!' },
        { top: 'KETIKA DAPAT...', bottom: 'PROMO GRATIS ONGKIR!' },
        { top: 'PAS SAMPAI RUMAH...', bottom: 'LANGSUNG KETEMU KASUR!' },
        { top: 'KETIKA HUJAN TURUN...', bottom: 'PAS LAGI REBAHAN DI RUMAH' },
        { top: 'KETIKA MAKANAN...', bottom: 'DATANG PAS LAGI LAPAR-LAPARNYA' },
        { top: 'POV:', bottom: 'ANTREAN KASIR KOSONG PAS GILIRAN KAMU' },
        { top: 'KETIKA LAGU FAVORIT...', bottom: 'TIBA-TIBA DIPUTAR DI KAFE' },
        { top: 'PAS CEK HARGA...', bottom: 'TERNYATA LAGI DISKON!' },
        { top: 'KETIKA...', bottom: 'DAPAT PARKIR PALING DEKAT PINTU MASUK' }
    ],
    'SAD': [
        { top: 'POV:', bottom: 'LAGI MERENUNGI NASIB' },
        { top: 'DOMPET TIPIS...', bottom: 'TANGGAL TUA MASIH LAMA' },
        { top: 'CHAT PANJANG...', bottom: 'CUMA DIBALAS "Y"' },
        { top: 'PAS MAU MAKAN...', bottom: 'LAUK TERAKHIR DIAMBIL TEMAN' },
        { top: 'KETIKA...', bottom: 'DI-GHOSTING PAS LAGI SAYANG-SAYANGNYA' },
        { top: 'PAS BUKA KULKAS...', bottom: 'ISINYA CUMA AIR PUTIH' },
        { top: 'KETIKA PAKET DATANG...', bottom: 'TAPI BARANGNYA BEDA SAMA FOTO' },
        { top: 'PAS MAU BERANGKAT...', bottom: 'HUJAN TURUN DERAS BANGET' },
        { top: 'KETIKA BATERAI HP...', bottom: 'TINGGAL 1% DI TENGAH JALAN' },
        { top: 'PAS SADAR...', bottom: 'LIBURAN UDAH HABIS AJA' },
        { top: 'KETIKA ES KRIM...', bottom: 'JATUH SEBELUM SEMPAT DIMAKAN' },
        { top: 'PAS CEK KERANJANG...', bottom: 'BARANGNYA UDAH HABIS STOK' },
        { top: 'KETIKA LIHAT...', bottom: 'HARGA CABAI NAIK LAGI' },
        { top: 'PAS UDAH NGANTRE LAMA...', bottom: 'EH MENUNYA HABIS' },
        { top: 'KETIKA GORENGAN...', bottom: 'TINGGAL TEPUNGNYA DOANG' }
    ],
    'ANGRY': [
        { top: 'PAS LAGI PRESENTASI...', bottom: 'LAPTOPNYA TIBA-TIBA UPDATE!' },
        { top: 'PAS LAGI SERU MAIN...', bottom: 'TIBA-TIBA WIFI MATI!' },
        { top: 'JANGAN GANGGU!', bottom: 'LAGI NUNGGU MODEL SELESAI TRAINING!' },
        { top: 'UDAH NUNGGU LAMA...', bottom: 'TERNYATA GAK JADI PERGI!' },
        { top: 'PAS LAGI TIDUR ENAK...', bottom: 'ADA YANG BANGUNIN SURUH MANDI!' },
        { top: 'KETIKA...', bottom: 'LU NGODING TAPI ERROR MULU' },
        { top: 'PAS LAGI BURU-BURU...', bottom: 'LAMPU MERAHNYA LAMA BANGET!' },
        { top: 'KETIKA ADA YANG...', bottom: 'NYEROBOT ANTREAN!' },
        { top: 'PAS MOTOR DI DEPAN...', bottom: 'SEIN KIRI TAPI BELOK KANAN!' },
        { top: 'PAS LAGI NONTON SERU...', bottom: 'IKLANNYA MUNCUL LAGI!' },
        { top: 'KETIKA CHARGER...', bottom: 'DIPINJAM TAPI GAK DIBALIKIN!' },
        { top: 'PAS UDAH DANDAN RAPI...', bottom: 'ACARANYA DIBATALIN!' },
        { top: 'KETIKA ADA MOBIL...', bottom: 'PARKIR NUTUPIN GERBANG RUMAH!' },
        { top: 'PAS TELEPON CS...', bottom: 'DISURUH TUNGGU 30 MENIT!' },
        { top: 'KETIKA REMOTE TV...', bottom: 'HILANG PAS MAU GANTI CHANNEL!' },
        { top: 'PAS MAU MANDI...', bottom: 'AIRNYA MATI!' }
    ],
    'NEUTRAL': [
        { top: 'TAMPANG AKU KALAU...', bottom: 'DITANYA KAPAN NIKAH' },
        { top: 'NO COMMENT...', bottom: 'LAGI MODE HEMAT ENERGI' },
        { top: 'KULIAH JAM 7 PAGI...', bottom: 'DOSENNYA GAK DATANG' },
        { top: 'LAGI MIKIR...', bottom: 'NANTI SIANG MAKAN APA YA?' },
        { top: 'POV:', bottom: 'PURA-PURA MERHATIKAN ORANG NGOMONG' },
        { top: 'KETIKA...', bottom: 'TEMEN BILANG "GAK APA-APA"' },
        { top: 'INI MUKA', bottom: 'ORANG YANG UDAH PASRAH SAMA DEADLINE' },
        { top: 'MUKA PAS...', bottom: 'NUNGGU NOMOR ANTREAN DIPANGGIL' },
        { top: 'KETIKA DITANYA...', bottom: '"MAU MAKAN DI MANA?"' },
        { top: 'POV:', bottom: 'LAGI NUNGGU NASI MATANG' },
        { top: 'EKSPRESI PAS BACA...', bottom: 'GRUP WA KELUARGA' },
        { top: 'KETIKA...', bottom: 'LOADING-NYA GAK SELESAI-SELESAI' },
        { top: 'MUKA PAS...', bottom: 'PURA-PURA NGERTI PENJELASAN ORANG' },
        { top: 'SENIN PAGI...', bottom: 'MODE AUTOPILOT AKTIF' },
        { top: 'POV:', bottom: 'LAGI NUNGGU KERETA YANG TELAT' },
        { top: 'KETIKA...', bottom: 'DENGAR CERITA YANG SAMA UNTUK KESEPULUH KALINYA' },
        { top: 'MUKA PAS...', bottom: 'NUNGGU LIFT YANG GAK DATANG-DATANG' }
    ],
    'FEAR': [
        { top: 'KETIKA LIHAT...', bottom: 'ADA KECOA TERBANG!' },
        { top: 'MUKA PAS TAU...', bottom: 'BESOK DEADLINE TUGAS!' },
        { top: 'PAS NGECEK M-BANKING...', bottom: 'SALDO TINGGAL BELASAN RIBU!' },
        { top: 'KETIKA NYOKAP TANYA...', bottom: '"TUPPERWARE DIMANA?"' },
        { top: 'PAS LAGI UJIAN...', bottom: 'PENGAWAS BERDIRI DI SAMPING MEJA' },
        { top: 'PAS DENGAR...', bottom: 'SUARA ANEH TENGAH MALAM' },
        { top: 'KETIKA HP...', bottom: 'HAMPIR JATUH DARI TANGAN' },
        { top: 'PAS MAU BAYAR...', bottom: 'DOMPETNYA KETINGGALAN!' },
        { top: 'KETIKA MAMA BILANG...', bottom: '"NANTI KITA BICARA DI RUMAH"' },
        { top: 'PAS BENSIN...', bottom: 'TINGGAL SATU STRIP DI JALAN SEPI' },
        { top: 'KETIKA ADA TELEPON...', bottom: 'DARI NOMOR TAK DIKENAL' },
        { top: 'PAS LAGI SENDIRIAN...', bottom: 'LAMPU TIBA-TIBA MATI' },
        { top: 'KETIKA BOS BILANG...', bottom: '"BISA KE RUANGAN SAYA SEBENTAR?"' },
        { top: 'PAS SADAR...', bottom: 'KOMPOR BELUM DIMATIIN!' },
        { top: 'KETIKA DOKTER GIGI...', bottom: 'MULAI NYALAIN BORNYA' }
    ],
    'DISGUST': [
        { top: 'PAS NYIUM BAU...', bottom: 'KAOS KAKI TEMEN!' },
        { top: 'EKSPRESI KETIKA...', bottom: 'MAKANAN JATUH BELUM 5 MENIT' },
        { top: 'LIHAT ORANG...', bottom: 'MAKAN MIE INSTAN PAKAI NASI & ROTI' },
        { top: 'PAS PEGANG...', bottom: 'GAGANG PINTU WC UMUM YANG BASAH' },
        { top: 'EKSPRESI KETIKA...', bottom: 'NGINJAK BECEKAN PAKAI KAOS KAKI' },
        { top: 'PAS BUKA KULKAS...', bottom: 'ADA MAKANAN BASI DARI MINGGU LALU' },
        { top: 'KETIKA LIHAT ORANG...', bottom: 'BUANG SAMPAH SEMBARANGAN' },
        { top: 'PAS NEMU RAMBUT...', bottom: 'DI DALAM MAKANAN' },
        { top: 'KETIKA MINUM SUSU...', bottom: 'TERNYATA UDAH KEDALUWARSA' },
        { top: 'PAS LIHAT...', bottom: 'CUCIAN PIRING NUMPUK DI WASTAFEL' },
        { top: 'KETIKA ORANG...', bottom: 'BERSIN GAK DITUTUP' },
        { top: 'PAS NYIUM BAU...', bottom: 'SELOKAN DEPAN RUMAH' },
        { top: 'KETIKA NASI...', bottom: 'KEMARIN MASIH ADA DI RICE COOKER' },
        { top: 'PAS LIHAT...', bottom: 'KECOA DI DAPUR' },
        { top: 'KETIKA ORANG...', bottom: 'MAKAN SAMBIL KECAP-KECAP' }
    ],
    'SURPRISE': [
        { top: 'HAH?!', bottom: 'TERNYATA DIA UDAH PUNYA PACAR?!' },
        { top: 'PLOT TWIST:', bottom: 'HARI INI TANGGAL MERAH!' },
        { top: 'PAS BUKA DOMPET...', bottom: 'TERNYATA MASIH ADA UANG BIRU!' },
        { top: 'HAH?!', bottom: 'UDAH HARI SENIN LAGI?!' },
        { top: 'HAH?!', bottom: 'PAKETNYA UDAH SAMPAI?!' },
        { top: 'KETIKA...', bottom: 'DAPAT DISKON 90%!' },
        { top: 'KAGET PAS LIHAT...', bottom: 'TAGIHAN LISTRIK BULAN INI' },
        { top: 'HAH?!', bottom: 'UDAH AKHIR TAHUN AJA?!' },
        { top: 'PAS NIMBANG...', bottom: 'BERAT BADAN NAIK 3 KILO' },
        { top: 'KETIKA NAMA KAMU...', bottom: 'KELUAR PAS UNDIAN DOORPRIZE!' },
        { top: 'KETIKA TEMAN LAMA...', bottom: 'TIBA-TIBA CHAT DULUAN' },
        { top: 'PAS NYARI KACAMATA...', bottom: 'TERNYATA LAGI DIPAKAI' },
        { top: 'KETIKA...', bottom: 'ANGKOT BERHENTI TEPAT DI DEPAN KAMU' },
        { top: 'PAS LIHAT...', bottom: 'JAM UDAH TENGAH MALAM' }
    ]
};

// Camera frames are mirrored like a selfie; uploaded photos are drawn as they are
function generateMeme(emotion, source, mirror = true) {
    memeVersion++;
    sharedMeme = null;

    const ctxMeme = memeCanvas.getContext('2d');
    const emotionTexts = memeTexts[emotion] || [{ top: 'KETIKA...', bottom: '...' }];
    const randomIdx = Math.floor(Math.random() * emotionTexts.length);
    const text = emotionTexts[randomIdx];

    memeCanvas.width = source.width;
    memeCanvas.height = source.height;
    ctxMeme.clearRect(0, 0, memeCanvas.width, memeCanvas.height);

    if (mirror) {
        ctxMeme.translate(memeCanvas.width, 0);
        ctxMeme.scale(-1, 1);
    }
    ctxMeme.drawImage(source, 0, 0, memeCanvas.width, memeCanvas.height);
    ctxMeme.setTransform(1, 0, 0, 1, 0, 0); 

    // Scale the font with the frame so the text looks the same on any camera resolution
    const fontSize = Math.round(memeCanvas.width / 16);
    const lineHeight = fontSize * 1.1;
    const margin = Math.round(fontSize * 0.5);
    const maxWidth = memeCanvas.width - margin * 2;

    // Top text starts below the logo badge so the two never overlap
    const logoBottom = drawMemeLogos(ctxMeme, margin);
    const topStart = logoBottom ? logoBottom + margin * 0.6 : margin;

    ctxMeme.font = `bold ${fontSize}px Impact, sans-serif`;
    ctxMeme.fillStyle = 'white';
    ctxMeme.strokeStyle = 'black';
    ctxMeme.lineWidth = Math.max(2, fontSize / 9);
    ctxMeme.lineJoin = 'round';
    ctxMeme.textAlign = 'center';
    ctxMeme.textBaseline = 'top';

    const topLines = wrapText(ctxMeme, text.top, maxWidth);
    topLines.forEach((line, i) => drawMemeLine(ctxMeme, line, topStart + i * lineHeight));

    const bottomLines = wrapText(ctxMeme, text.bottom, maxWidth);
    const bottomStart = memeCanvas.height - margin - bottomLines.length * lineHeight;
    bottomLines.forEach((line, i) => drawMemeLine(ctxMeme, line, bottomStart + i * lineHeight));
}

// Draws the loaded logos in a row in the top-left corner and returns the row's bottom edge (0 if no logos)
function drawMemeLogos(ctx, margin) {
    const logos = memeLogos.filter(img => img.complete && img.naturalWidth > 0);
    if (!logos.length) return 0;

    const logoHeight = Math.round(memeCanvas.width / 24);
    const gap = Math.round(logoHeight * 0.35);

    let x = margin;
    logos.forEach(img => {
        const width = img.naturalWidth * logoHeight / img.naturalHeight;
        ctx.drawImage(img, x, margin, width, logoHeight);
        x += width + gap;
    });

    return margin + logoHeight;
}

function drawMemeLine(ctx, line, y) {
    ctx.strokeText(line, memeCanvas.width / 2, y);
    ctx.fillText(line, memeCanvas.width / 2, y);
}

function wrapText(ctx, text, maxWidth) {
    const lines = [];
    let current = '';
    for (const word of text.split(' ')) {
        const candidate = current ? `${current} ${word}` : word;
        if (current && ctx.measureText(candidate).width > maxWidth) {
            lines.push(current);
            current = word;
        } else {
            current = candidate;
        }
    }
    if (current) lines.push(current);
    return lines;
}

btnStart.addEventListener('click', startCamera);
btnStop.addEventListener('click', stopCamera);
btnMeme.addEventListener('click', requestMeme);
btnRetake.addEventListener('click', retakeMeme);
btnUpload.addEventListener('click', () => photoInput.click());
photoInput.addEventListener('change', handlePhotoUpload);

// Kiosk behaviour: when nobody has used the page for a while, return to the start screen for the next visitor
['pointerdown', 'keydown', 'touchstart'].forEach(eventName => {
    document.addEventListener(eventName, () => { lastActivity = Date.now(); }, { passive: true });
});
setInterval(() => {
    const atStart = !videoStream && !photoSource && memeArea.style.display !== 'block';
    if (!atStart && Date.now() - lastActivity > IDLE_RESET_MS) resetToStart();
}, 5000);

if (btnDownloadMeme) {
    btnDownloadMeme.addEventListener('click', () => {
        const imageURL = memeCanvas.toDataURL('image/png');

        const downloadLink = document.createElement('a');
        downloadLink.href = imageURL;
        
        downloadLink.download = `MoodLens_Meme_${new Date().getTime()}.png`;
        
        document.body.appendChild(downloadLink);
        downloadLink.click();
        
        document.body.removeChild(downloadLink);
    });
}

function openShareDialog() {
    // The same meme only needs to be uploaded once
    showShareStep(sharedMeme ? 'shareResult' : 'shareConsent');
    shareDialog.showModal();
}

function showShareStep(stepId) {
    shareDialog.querySelectorAll('.share-step').forEach(step => {
        step.hidden = step.id !== stepId;
    });
}

async function shareMeme() {
    if (shareUploading) return;
    shareUploading = true;
    const version = memeVersion;
    showShareStep('shareLoading');

    try {
        const response = await fetch('/share_meme', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: memeCanvas.toDataURL('image/jpeg', 0.9) })
        });
        const data = await response.json();
        if (!response.ok || !data.qr) throw new Error(data.error || `HTTP ${response.status}`);
        if (version !== memeVersion) return;

        sharedMeme = data;
        document.getElementById('shareQr').src = data.qr;
        showShareStep('shareResult');
    } catch (error) {
        console.error("Share failed:", error);
        if (version === memeVersion) showShareStep('shareError');
    } finally {
        shareUploading = false;
    }
}

if (shareDialog) {
    document.getElementById('btnShare').addEventListener('click', openShareDialog);
    document.getElementById('btnShareConfirm').addEventListener('click', shareMeme);
    document.getElementById('btnShareRetry').addEventListener('click', shareMeme);
    shareDialog.querySelectorAll('[data-share-close]').forEach(button => {
        button.addEventListener('click', () => shareDialog.close());
    });
    // Clicking the dimmed backdrop (outside the dialog box) closes it too
    shareDialog.addEventListener('click', event => {
        // A click on a button also bubbles here, and by then the dialog may have shrunk under the cursor
        if (event.target !== shareDialog) return;
        const box = shareDialog.getBoundingClientRect();
        const outside = event.clientX < box.left || event.clientX > box.right ||
                        event.clientY < box.top || event.clientY > box.bottom;
        if (outside) shareDialog.close();
    });
}
