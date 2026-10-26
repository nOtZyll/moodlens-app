@echo off
rem Starts MoodLens and opens the Detect page full screen (kiosk mode) in Microsoft Edge.
rem Exit kiosk mode with Alt+F4, then close the "MoodLens server" window to stop the server.
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo Virtual environment not found. Run these first:
    echo     py -3.11 -m venv .venv
    echo     .venv\Scripts\python -m pip install -r requirements.txt
    pause
    exit /b 1
)

start "MoodLens server" ".venv\Scripts\python.exe" -m flask --app app run --port 5000

echo Waiting for MoodLens to finish loading the model...
:wait
curl -s -o nul http://127.0.0.1:5000/ || (ping -n 3 127.0.0.1 >nul & goto wait)

start "" msedge --kiosk http://localhost:5000/detect --edge-kiosk-type=fullscreen --no-first-run
