# Menggunakan sistem operasi Linux dengan Python 3.11 (versi library di requirements.txt butuh minimal 3.11)
FROM python:3.11-slim

# Menyiapkan folder kerja di dalam server
WORKDIR /app

# Menyalin requirements.txt dan menginstal library (termasuk onnxruntime & OpenCV)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Menyalin semua file project kamu ke dalam server
COPY . .

# Hugging Face mewajibkan web berjalan di port 7860
EXPOSE 7860

# Perintah untuk menyalakan Flask dengan Gunicorn
CMD ["gunicorn", "-b", "0.0.0.0:7860", "app:app"]