import os
import sys
from collections import OrderedDict, deque
from threading import Lock

# Windows consoles default to a legacy codepage that can't print the emoji in the log messages
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

from flask import Flask, render_template, request, jsonify
import cv2
import numpy as np
import base64
import io
import json
import urllib.request
import qrcode
from dotenv import load_dotenv
import onnxruntime as ort

app = Flask(__name__)
EMOTIONS_LIST = ['angry', 'disgust', 'fear', 'happy', 'neutral', 'sad', 'surprise']

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# "Send to Phone" uploads memes to Google Drive through an Apps Script web app (see README).
# Without both settings in .env the feature stays hidden.
load_dotenv(os.path.join(BASE_DIR, '.env'))
DRIVE_UPLOAD_URL = os.environ.get('DRIVE_UPLOAD_URL', '').strip()
DRIVE_UPLOAD_TOKEN = os.environ.get('DRIVE_UPLOAD_TOKEN', '').strip()
SHARE_ENABLED = bool(DRIVE_UPLOAD_URL and DRIVE_UPLOAD_TOKEN)
MAX_SHARE_BYTES = 5 * 1024 * 1024

FACE_MODEL_PATH = os.path.join(BASE_DIR, 'models', 'face_detection_yunet_2023mar.onnx')

# 2 model HSEmotion EfficientNet-B2 (AffectNet) dipakai sebagai pengekstrak fitur.
# Versi *_feat.onnx = model asli + output tambahan berisi fitur sebelum classifier.
# Fiturnya digabung lalu diklasifikasi oleh classifier baru (emotion_head.npz) yang
# dilatih ulang di RAF-DB + AffectNet, urutan kelas sesuai EMOTIONS_LIST.
EMOTION_MODELS = ['enet_b2_7_feat.onnx', 'enet_b2_8_feat.onnx']
EMOTION_HEAD_PATH = os.path.join(BASE_DIR, 'models', 'emotion_head.npz')
EMOTION_IMG_SIZE = 260
IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)

print("Loading HSEmotion models...")
model_paths = [os.path.join(BASE_DIR, 'models', name) for name in EMOTION_MODELS]
if all(os.path.exists(p) for p in model_paths + [FACE_MODEL_PATH, EMOTION_HEAD_PATH]):
    # Tanpa ini, 2 sesi yang jalan bergantian saling berebut thread CPU (~3x lebih lambat)
    session_options = ort.SessionOptions()
    session_options.add_session_config_entry("session.intra_op.allow_spinning", "0")
    emotion_session = [
        ort.InferenceSession(p, session_options, providers=['CPUExecutionProvider'])
        for p in model_paths
    ]
    emotion_head = np.load(EMOTION_HEAD_PATH)
    face_detector = cv2.FaceDetectorYN.create(FACE_MODEL_PATH, "", (320, 320), 0.8, 0.3, 5000)
    print("✅ Model loaded successfully!")
else:
    print("❌ ERROR: File model di folder 'models/' tidak ditemukan!")
    emotion_session = None
    face_detector = None

# Rata-rata probabilitas beberapa frame terakhir supaya hasil tidak loncat-loncat
SMOOTHING_WINDOW = 6
# Riwayat disimpan per pengguna supaya hasil antar pengguna tidak tercampur.
# Kalau melebihi batas, riwayat yang paling lama tidak aktif dibuang.
MAX_SMOOTHING_CLIENTS = 200
client_probs = OrderedDict()
client_probs_lock = Lock()


def smooth_probs(client_id, probs):
    # Tanpa client_id (misal kirim 1 foto saja) tidak ada frame untuk dirata-rata
    if not client_id:
        return probs
    with client_probs_lock:
        history = client_probs.setdefault(client_id, deque(maxlen=SMOOTHING_WINDOW))
        client_probs.move_to_end(client_id)
        history.append(probs)
        while len(client_probs) > MAX_SMOOTHING_CLIENTS:
            client_probs.popitem(last=False)
        return np.mean(history, axis=0)


def clear_probs(client_id):
    with client_probs_lock:
        client_probs.pop(client_id, None)


def detect_faces(img):
    h, w = img.shape[:2]
    face_detector.setInputSize((w, h))
    _, faces = face_detector.detect(img)
    if faces is None:
        return []
    # urutkan dari wajah terbesar
    return sorted(faces, key=lambda f: f[2] * f[3], reverse=True)


def predict_emotion(face_bgr):
    face_rgb = cv2.cvtColor(face_bgr, cv2.COLOR_BGR2RGB)
    x = cv2.resize(face_rgb, (EMOTION_IMG_SIZE, EMOTION_IMG_SIZE)).astype(np.float32) / 255.0
    x = (x - IMAGENET_MEAN) / IMAGENET_STD
    x = x.transpose(2, 0, 1)[np.newaxis, ...]
    # output[1] = fitur sebelum classifier
    features = np.concatenate([
        session.run(None, {session.get_inputs()[0].name: x})[1][0]
        for session in emotion_session
    ])
    features = (features - emotion_head['mean']) / emotion_head['std']
    logits = emotion_head['W'] @ features + emotion_head['b']
    e_x = np.exp(logits - np.max(logits))
    return e_x / e_x.sum()


@app.route('/')
def home():
    return render_template('index.html')

@app.route('/detect')
def detect():
    return render_template('detect.html', share_enabled=SHARE_ENABLED)

@app.route('/emotions')
def emotions():
    return render_template('emotions.html')

@app.route('/about')
def about():
    return render_template('about.html')

@app.route('/how-it-works')
def how_it_works():
    return render_template('how_it_works.html')

@app.route('/emotion/<emotion_name>')
def emotion_detail(emotion_name):
    emotions_data = {
        'happy': {
            'title': 'THE EMOTION OF JOY',
            'tags': ['PRIMARY', 'POSITIVE'],
            'intensity': '8.5',
            'description': 'A positive, uplifting emotional state characterized by feelings of immense joy, satisfaction, contentment, and well-being.',
            'reason': 'Happiness acts as the brain\'s reward mechanism. It releases chemicals like dopamine to encourage us to repeat beneficial behaviors.',
            'conditions': 'Achieving a goal, spending quality time with loved ones, or appreciating a beautiful moment.',
            'image': '/static/images/spgbb hepi 3.png'
        },
        'sad': {
            'title': 'DEEP DIVE: SADNESS',
            'tags': ['GRIEF', 'NEGATIVE'],
            'intensity': '7.0',
            'description': 'An emotional pain associated with feelings of disadvantage, loss, despair, grief, helplessness, and sorrow.',
            'reason': 'Sadness forces us to slow down, allowing us to process difficult life events and heal emotionally.',
            'conditions': 'Losing a loved one, experiencing rejection, or feeling profound empathy.',
            'image': '/static/images/spgbb sad.png'
        },
        'angry': {
            'title': 'THE FIRE OF ANGER',
            'tags': ['INTENSE', 'DEFENSIVE'],
            'intensity': '9.0',
            'description': 'A strong feeling of displeasure, hostility, or antagonism towards someone or something you feel has deliberately done you wrong.',
            'reason': 'Anger serves as a psychological defense mechanism to protect our personal boundaries and respond to threats.',
            'conditions': 'Experiencing unfair treatment, feeling disrespected, or dealing with intense frustration.',
            'image': '/static/images/spgbb angry.png'
        },
        'neutral': {
            'title': 'STATE OF CALM',
            'tags': ['BASELINE', 'PEACEFUL'],
            'intensity': '2.0',
            'description': 'A baseline emotional state lacking significant positive or negative intensity. It is a state of calm and emotional rest.',
            'reason': 'A neutral state conserves our brain\'s energy and provides necessary emotional stability.',
            'conditions': 'Performing routine tasks, relaxing in a quiet environment, or simply resting.',
            'image': '/static/images/spgbb neutral.png'
        },
        'fear': {
            'title': 'THE SURVIVAL INSTINCT',
            'tags': ['SURVIVAL', 'NEGATIVE'],
            'intensity': '9.5',
            'description': 'An intense emotion aroused by impending danger, evil, pain, whether the threat is real or imagined.',
            'reason': 'Fear triggers the "fight or flight" response, preparing the body to deal with potential threats to stay alive.',
            'conditions': 'Facing a dangerous situation, experiencing something unknown, or anticipating harm.',
            'image': '/static/images/spgbb fear.png'
        },
        'disgust': {
            'title': 'THE FEELING OF REPULSION',
            'tags': ['AVOIDANCE', 'NEGATIVE'],
            'intensity': '7.5',
            'description': 'A feeling of revulsion or strong disapproval aroused by something unpleasant or offensive.',
            'reason': 'Evolved to protect us from disease and poisons by making us avoid foul-smelling or rotten substances.',
            'conditions': 'Encountering bad smells, tasting spoiled food, or witnessing morally unacceptable behavior.',
            'image': '/static/images/spgbb disgust.png'
        },
        'surprise': {
            'title': 'THE UNEXPECTED',
            'tags': ['SUDDEN', 'NEUTRAL'],
            'intensity': '8.0',
            'description': 'A brief emotional state experienced as the result of an unexpected event. It can be positive, negative, or neutral.',
            'reason': 'Interrupts our current focus to direct our full attention towards a sudden change in our environment.',
            'conditions': 'Receiving a sudden gift, hearing a loud noise, or encountering an unexpected situation.',
            'image': '/static/images/spgbb surprise.png'
        }
    }
    
    data = emotions_data.get(emotion_name.lower(), emotions_data['happy'])
    return render_template('emotion_details.html', emotion=data)

@app.route('/analyze_frame', methods=['POST'])
def analyze_frame():
    if emotion_session is None:
        return jsonify({'emotion': 'MODEL NOT LOADED', 'box': None, 'probabilities': {}})

    try:
        data = request.get_json()
        image_data = data['image']
        client_id = data.get('client_id')
        encoded_data = image_data.split(',')[1]
        nparr = np.frombuffer(base64.b64decode(encoded_data), np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        faces = detect_faces(img)
        if len(faces) == 0:
            clear_probs(client_id)
            return jsonify({'emotion': 'NO FACE DETECTED', 'box': None, 'probabilities': {}})

        x, y, w, h = [int(v) for v in faces[0][:4]]

        pad = int(0.1 * max(w, h))
        y1 = max(0, y - pad)
        y2 = min(img.shape[0], y + h + pad)
        x1 = max(0, x - pad)
        x2 = min(img.shape[1], x + w + pad)

        face_crop = img[y1:y2, x1:x2]
        if face_crop.shape[0] == 0 or face_crop.shape[1] == 0:
            return jsonify({'emotion': 'INVALID CROP', 'box': None, 'probabilities': {}})

        probs = smooth_probs(client_id, predict_emotion(face_crop))

        emotion_percentages = {
            name.upper(): round(float(probs[i]) * 100, 2)
            for i, name in enumerate(EMOTIONS_LIST)
        }
        dominant_emotion = EMOTIONS_LIST[int(np.argmax(probs))].upper()

        print(f"\r📸 DOMINAN: {dominant_emotion}     ", end="")

        return jsonify({
            'emotion': dominant_emotion,
            'probabilities': emotion_percentages,
            'box': {'x': x, 'y': y, 'w': w, 'h': h}
        })

    except Exception as e:
        print(f"\nError AI: {e}")
        return jsonify({'emotion': 'ERROR', 'box': None, 'probabilities': {}})

@app.route('/share_meme', methods=['POST'])
def share_meme():
    if not SHARE_ENABLED:
        return jsonify({'error': 'not_configured'}), 503

    data = request.get_json(silent=True) or {}
    image_data = data.get('image', '')
    if not image_data.startswith('data:image/jpeg;base64,'):
        return jsonify({'error': 'invalid_image'}), 400
    encoded = image_data.split(',', 1)[1]
    if len(encoded) * 3 // 4 > MAX_SHARE_BYTES:
        return jsonify({'error': 'too_large'}), 413

    payload = json.dumps({'token': DRIVE_UPLOAD_TOKEN, 'image': encoded}).encode()
    upload = urllib.request.Request(DRIVE_UPLOAD_URL, data=payload, headers={'Content-Type': 'application/json'})
    try:
        # Apps Script answers the POST with a redirect to the result, which urllib follows as a GET
        with urllib.request.urlopen(upload, timeout=30) as response:
            result = json.load(response)
    except (OSError, ValueError) as e:
        print(f"\nShare upload failed: {e}")
        return jsonify({'error': 'upload_failed'}), 502

    url = result.get('url', '')
    if not result.get('ok') or not url.startswith('https://drive.google.com/'):
        print(f"\nShare upload rejected: {result.get('error')}")
        return jsonify({'error': 'upload_failed'}), 502

    return jsonify({'url': url, 'qr': qr_data_url(url)})

def qr_data_url(text):
    image = qrcode.make(text, box_size=10, border=2)
    buffer = io.BytesIO()
    image.save(buffer, format='PNG')
    return 'data:image/png;base64,' + base64.b64encode(buffer.getvalue()).decode()

if __name__ == '__main__':
    app.run(debug=True)
