# PC STT Setup

This setup keeps the Brain Pi responsible for:

- camera video
- Gemma 4 responses
- on-screen dashboard state
- speaking answers through the Pi speakers

Your PC is responsible for:

- always listening on its own microphone
- transcribing speech locally
- sending final transcript text to the Brain Pi relay

## 1. Prepare the Brain Pi

Make sure the Brain Pi is already running the latest relay build:

```bash
cd ~/TRIAGE
git pull origin main
npm run build
sudo systemctl restart triage-dashboard-server
sudo systemctl restart triage-dashboard-kiosk
```

Quick relay test from the Pi:

```bash
curl http://localhost:3000/api/transcript \
  -H "Content-Type: application/json" \
  -d '{"text":"Manual relay test from the Pi.","source":"pi-test"}'
```

## 2. Prepare your PC

From your PC in this repo:

```bash
cd TRIAGE
python -m venv .venv-pc
.venv-pc\Scripts\activate
pip install --upgrade pip
pip install -r pc\requirements.txt
```

## 3. Find your microphone device

If you want to inspect available microphones:

```bash
python pc\live_transcribe_and_send.py --list-devices
```

If your default microphone is already correct, you can skip this.

## 4. Manual sender smoke test

Before turning on continuous listening, verify that the PC can reach the Pi:

```bash
python pc\send_transcript.py --pi http://TRIAGE_PI_IP:3000 "Hello Triage, this is a manual PC test."
```

The Brain Pi dashboard should think and then speak.

## 5. Start always-listening STT on the PC

Start with the default microphone:

```bash
python pc\live_transcribe_and_send.py --pi http://TRIAGE_PI_IP:3000
```

If you need a specific microphone:

```bash
python pc\live_transcribe_and_send.py --pi http://TRIAGE_PI_IP:3000 --input-device 3
```

If you want a bit more accuracy and your PC can handle it:

```bash
python pc\live_transcribe_and_send.py --pi http://TRIAGE_PI_IP:3000 --model small.en
```

What to expect:

- first it calibrates for about 2 seconds
- then it prints `Listening...`
- when you speak, it prints `Voice detected`
- after a short pause, it transcribes locally
- then it sends the final text to the Brain Pi

## 5b. Browser fallback for Windows audio issues

If the Python listener cannot open your Windows microphone, use the browser relay page instead:

1. Open [pc/live_transcribe_browser.html](/C:/Users/roben/Downloads/TRIAGE/pc/live_transcribe_browser.html) in Chrome or Edge on your PC.
2. Keep the Brain Pi URL set to:

```text
http://192.168.0.232:3000
```

3. Click `Start Listening`.
4. Allow microphone access in the browser.
5. Speak normally. Final transcripts will be posted to the Brain Pi relay.

This uses the browser's speech recognition stack instead of Python/PortAudio, which is often more reliable on Windows.

## 6. Recommended everyday command

For a good balance of speed and accuracy on most PCs:

```bash
python pc\live_transcribe_and_send.py --pi http://TRIAGE_PI_IP:3000 --model base.en
```

## 7. If it triggers too easily

Raise the gate:

```bash
python pc\live_transcribe_and_send.py --pi http://TRIAGE_PI_IP:3000 --energy-multiplier 4.0
```

## 8. If it misses speech

Lower the gate a bit:

```bash
python pc\live_transcribe_and_send.py --pi http://TRIAGE_PI_IP:3000 --energy-multiplier 2.2
```

Or shorten the silence cutoff:

```bash
python pc\live_transcribe_and_send.py --pi http://TRIAGE_PI_IP:3000 --silence-ms 800
```

## 9. If you want it to launch every time on Windows

After confirming it works:

1. Create a shortcut that runs:

```bat
cmd /k "C:\path\to\TRIAGE\.venv-pc\Scripts\activate.bat && python C:\path\to\TRIAGE\pc\live_transcribe_and_send.py --pi http://TRIAGE_PI_IP:3000 --model base.en"
```

2. Put that shortcut in your Windows Startup folder:

```text
shell:startup
```

## 10. Notes

- The first run downloads the Whisper model automatically.
- `base.en` is a good default.
- `small.en` is usually a bit more accurate but slower.
- The Brain Pi no longer needs to do microphone STT for this flow.
