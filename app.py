import os
import sys
os.environ["TF_USE_LEGACY_KERAS"] = "1"

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
import tensorflow as tf
from tensorflow.keras.models import load_model
from tensorflow.keras.layers import Dense, DepthwiseConv2D
import efficientnet.tfkeras as efn 

app = Flask(__name__)
EMOTIONS_LIST = ['angry', 'disgust', 'fear', 'happy', 'neutral', 'sad', 'surprise']

# "Send to Phone" uploads memes to Google Drive through an Apps Script web app (see README).
# Without both settings in .env the feature stays hidden.
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env'))
DRIVE_UPLOAD_URL = os.environ.get('DRIVE_UPLOAD_URL', '').strip()
DRIVE_UPLOAD_TOKEN = os.environ.get('DRIVE_UPLOAD_TOKEN', '').strip()
SHARE_ENABLED = bool(DRIVE_UPLOAD_URL and DRIVE_UPLOAD_TOKEN)
MAX_SHARE_BYTES = 5 * 1024 * 1024

print("Loading Custom EfficientNet Model...")
MODEL_PATH = 'FacialExpressionModel.h5'

class SafeDense(Dense):
    def __init__(self, **kwargs):
        kwargs.pop('quantization_config', None)
        super().__init__(**kwargs)

class SafeDepthwiseConv2D(DepthwiseConv2D):
    def __init__(self, **kwargs):
        kwargs.pop('groups', None)
        super().__init__(**kwargs)

if os.path.exists(MODEL_PATH):
    my_model = load_model(
        MODEL_PATH, 
        custom_objects={
            'Dense': SafeDense,
            'DepthwiseConv2D': SafeDepthwiseConv2D
        }, 
        compile=False
    )
    print("✅ Model loaded successfully!")
else:
    print(f"❌ ERROR: File {MODEL_PATH} tidak ditemukan! Pastikan ada di folder yang sama.")
    my_model = None

face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')

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
    if my_model is None:
        return jsonify({'emotion': 'MODEL NOT LOADED', 'box': None, 'probabilities': {}})

    try:
        data = request.get_json()
        image_data = data['image']
        encoded_data = image_data.split(',')[1]
        nparr = np.frombuffer(base64.b64decode(encoded_data), np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        faces = face_cascade.detectMultiScale(gray, scaleFactor=1.3, minNeighbors=5, minSize=(50, 50))
        
        if len(faces) == 0:
            return jsonify({'emotion': 'NO FACE DETECTED', 'box': None, 'probabilities': {}})
            
        (x, y, w, h) = faces[0]
        
        pad = 15 
        y1 = max(0, y - pad)
        y2 = min(img.shape[0], y + h + pad)
        x1 = max(0, x - pad)
        x2 = min(img.shape[1], x + w + pad)
        
        face_crop_gray = gray[y1:y2, x1:x2]
        
        if face_crop_gray.shape[0] == 0 or face_crop_gray.shape[1] == 0:
            return jsonify({'emotion': 'INVALID CROP', 'box': None, 'probabilities': {}})

        
        face_crop_rgb = cv2.cvtColor(face_crop_gray, cv2.COLOR_GRAY2RGB)
        face_crop_resized = cv2.resize(face_crop_rgb, (96, 96), interpolation=cv2.INTER_LINEAR) 
        face_crop_batch = np.expand_dims(face_crop_resized, axis=0)
        
        preds = my_model.predict(face_crop_batch, verbose=0)[0]

        BOOSTS = {
            'angry': 1.0,
            'disgust': 7.0,
            'fear': 2.0,
            'happy': 1.0,
            'neutral': 0.6,
            'sad': 3.0,
            'surprise': 1.0
        }

        boosted_preds = []
        for i, emotion_name in enumerate(EMOTIONS_LIST):
            boosted_val = float(preds[i]) * BOOSTS[emotion_name]
            boosted_preds.append(boosted_val)

        total_boosted = sum(boosted_preds)
        if total_boosted == 0:
            total_boosted = 1.0
            
        emotion_percentages = {}
        for i, emotion_name in enumerate(EMOTIONS_LIST):
            percent = (boosted_preds[i] / total_boosted) * 100
            emotion_percentages[emotion_name.upper()] = round(percent, 2)
        
        highest_index = np.argmax(boosted_preds)
        dominant_emotion = EMOTIONS_LIST[highest_index].upper()
        
        print(f"\r📸 DOMINAN: {dominant_emotion}     ", end="")

        return jsonify({
            'emotion': dominant_emotion,
            'probabilities': emotion_percentages,
            'box': {'x': int(x), 'y': int(y), 'w': int(w), 'h': int(h)} 
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
