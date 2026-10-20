# DocuVision - Installation and Operation (Windows 10 / 11)

Everything below is typed into **Windows PowerShell** (or PowerShell 7). Nothing needs Docker, WSL or a Linux shell, and nothing leaves your computer.

## 1. What you need

| Software | Version | Check with |
| --- | --- | --- |
| Node.js | **v26.5.1** (the scripts accept 22.13 or newer; your existing Node.js is never changed or downgraded) | `node -v` |
| Python | **3.11 or 3.12** (3.10+ is accepted with a warning) | `py -3.12 --version` |
| Tesseract OCR | 5.x (Windows build from UB Mannheim, includes `eng` and `osd`) | `tesseract --version` |

If something is missing, `winget` (included with Windows 10/11) can install it. Afterwards **open a new PowerShell window** so the updated PATH is picked up.

```powershell
winget install --id Python.Python.3.12 -e
winget install --id UB-Mannheim.TesseractOCR -e
# Node.js: install v26.5.1 from https://nodejs.org/dist/v26.5.1/ (or: winget install OpenJS.NodeJS)
```

## 2. Extract the ZIP

```powershell
Expand-Archive -Path "$HOME\Downloads\DocuVision_Complete_System.zip" -DestinationPath "$HOME\Projects" -Force
Set-Location "$HOME\Projects\DocuVision"
Get-ChildItem -Recurse | Unblock-File      # files from the internet are marked; this lets the .ps1 scripts run
```

Use a normal folder such as `C:\Projects`. Avoid folders that OneDrive or another sync tool is watching: they can lock the SQLite database file.

## 3. Quick way: two scripts

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1     # once
powershell -ExecutionPolicy Bypass -File .\scripts\start.ps1     # every time
```

`setup.ps1` installs the npm packages, creates `.env` with freshly generated secrets, creates the Python virtual environment `.venv` and installs `cv-service\requirements.txt`, finds Tesseract (and writes `TESSERACT_CMD` into `.env` if it is not on PATH), initialises the SQLite database and ends with a self-check. It is safe to run again.

`start.ps1` starts the Python service, waits until it answers, starts the web application and opens <http://localhost:3000>. Both services run in this one window with `[cv]` and `[web]` prefixes.

Register an account on the first page, then use **New Scan** (the page also has two sample pages you can try).

(`-ExecutionPolicy Bypass` only applies to that one command. Alternatively run `Set-ExecutionPolicy -Scope Process Bypass` once in the window and then call `.\scripts\setup.ps1` directly.)

## 4. Step by step (what the scripts do)

Run these from the project folder (`Set-Location "$HOME\Projects\DocuVision"`).

```powershell
# 3. Node.js packages
npm install

# 4. Python virtual environment
py -3.12 -m venv .venv                      # use "py -3.11" if you have 3.11

# 5. Python packages (FastAPI, Uvicorn, OpenCV, NumPy, Pillow, pytesseract, python-docx)
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r cv-service\requirements.txt

# 6. Tesseract path - only needed if this does not print a path:
where.exe tesseract
#    then edit .env and set, for example:
#    TESSERACT_CMD=C:\Program Files\Tesseract-OCR\tesseract.exe

# 7. .env file with generated SESSION_SECRET and CV_SERVICE_TOKEN
npm run setup:env

# 8. SQLite database
npm run db:init

# Optional: is everything usable? (Python, each package, Tesseract)
npm run check
```

Start the two services in **two PowerShell windows**:

```powershell
# window 1 - FastAPI computer-vision / OCR service (127.0.0.1:8001)
npm run start:cv

# window 2 - Express web application (http://localhost:3000)
npm start
```

Then open <http://localhost:3000> in Chrome, Edge or Firefox (step 11).

`npm run dev` does both in one window, exactly like `start.ps1`. `npm run start:cv` and `npm run dev` use the interpreter of `.venv` automatically (or the one named in `CV_PYTHON`). To launch the Python service completely by hand:

```powershell
Set-Location cv-service
..\.venv\Scripts\python.exe main.py
```

## 5. Stopping

Press **Ctrl+C once** in the window that runs `start.ps1` / `npm run dev` (it stops both services). If you started the services in two windows, press Ctrl+C in each.

If a window was closed without Ctrl+C and a port stays occupied (the launcher then says "Port ... is already in use"):

```powershell
Get-NetTCPConnection -LocalPort 8001,3000 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

## 6. Check that it works

```powershell
Invoke-RestMethod http://127.0.0.1:3000/healthz          # {status: ok}
Invoke-RestMethod http://127.0.0.1:8001/health           # CV service, OpenCV and Tesseract versions
```

Inside the application, the top bar shows an **Image service ready** badge when Express can reach the Python service and Tesseract works. Quick trial: **New Scan -> sample "letter photo" -> Upload and process -> (watch the stages) -> Review text -> Export**. The sample photos are also in `tests\fixtures\`.

## 7. Running the automated tests

```powershell
npm test                                                  # Node backend tests (no Python needed)
.\.venv\Scripts\python.exe -m pytest tests\cv -q          # computer-vision, OCR and DOCX tests
npm run test:integration                                  # real Express + real Python + real Tesseract
```

Tests that need Tesseract are skipped (with a reason) if it is not installed; the integration test skips itself the same way.

## 8. Configuration, data and cleaning up

* Settings are in `.env` (see `.env.example` for every option). Restart the services after changing it.
* The database is `data\docuvision.sqlite`; uploaded, processed and exported files are in `storage\`. Both are created automatically.
* To start from a clean state: stop DocuVision, then delete `data\` and `storage\`.
* To remove DocuVision: delete the project folder. Nothing is installed outside it except the tools you installed in step 1.
* To use another port: change `PORT` (web) or `CV_PORT` **and** `CV_SERVICE_URL` (Python service) in `.env`.

## 9. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| "running scripts is disabled on this system" or "is not digitally signed" | Use `powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1`, and run `Get-ChildItem -Recurse \| Unblock-File` once in the project folder. Or skip the scripts and use the commands in section 4 / `npm run dev`. |
| `setup.ps1`: "Python 3.11 or 3.12 was not found" | Install Python (section 1) and open a new PowerShell window. The Microsoft Store "python" shortcut does not count; the python.org / winget version does. |
| `pip` fails to build or find `opencv-python-headless` / `numpy` | Your Python is probably too new for prebuilt wheels. Install Python 3.12, delete the `.venv` folder and run `setup.ps1` again. |
| Badge "Image service offline" or error "The image-processing service is not reachable" | Start it (`npm run start:cv` or `npm run dev`). Check `http://127.0.0.1:8001/health`. |
| Error mentioning `CV_SERVICE_TOKEN` | The two services were started with different tokens. Both read `.env`; do not set the variable differently in a window, and restart both. |
| "Tesseract executable not found" | Install Tesseract (section 1) or set `TESSERACT_CMD` in `.env` to the full path of `tesseract.exe`; run `npm run check`. Image processing works without it; text recognition does not. |
| `Port 3000 (web app) is already in use` | Another program uses it. Change `PORT` in `.env`, or free it as shown in section 5. |
| Camera button does nothing or is greyed out | Browsers only allow the camera on `http://localhost:...` or HTTPS, and only after you click "Allow". Do not open the site through your LAN IP address. Another application may be using the camera. |
| `ExperimentalWarning: SQLite is an experimental feature` | Harmless: it is Node's built-in database module. |
| Upload rejected: "The image is larger than the 10 MB upload limit" | Raise `MAX_UPLOAD_SIZE` (bytes) in `.env` or use a smaller photo. |
| Forgot the password | There is no e-mail reset (the app is local). Register another account, or delete `data\docuvision.sqlite` to start over (this deletes all accounts and records). |

## 10. What has and has not been tested

This section is deliberately plain about the limits of verification.

**Executed and passing** (in the Linux development environment: Node.js 22.22, Python 3.13, Tesseract 5.3.4, OpenCV 5.0):

* `npm test` - 123 backend tests.
* `pytest tests/cv` - 138 computer-vision, OCR, DOCX and FastAPI tests; run again in a freshly installed virtual environment built only from `requirements.txt`.
* `npm run test:integration` - 10 end-to-end checks with the real Python service, OpenCV and Tesseract (letter OCR CER 0.00 %, page corners within 0.32 % of the image diagonal of the known positions, 7 of 8 form fields exactly right with the wrong one flagged for review, DSP Lab CER, `.docx` verified independently as Times New Roman 12 pt on A4, a clear error when the Python service is stopped).
* A complete browser walk-through (Chromium via Playwright, script not included in the ZIP): login, upload, dragging a corner handle, processing, OCR review and editing, export and download, structured form, history, DSP Lab with CSV, settings and password change, camera selection using Chromium's built-in fake camera, delete - plus layout checks at desktop, laptop and phone widths and a check that the page triggers no Content-Security-Policy violations.
* `scripts\dev.js`, `scripts\start-cv.js`, `cv-service\check_env.py` and the PowerShell scripts: `setup.ps1` and `start.ps1` were parsed and **executed with PowerShell 7 on Linux** (with the path separators adjusted for Linux), including a clean `npm install`, virtual-environment creation, `pip install -r requirements.txt`, database initialisation, start-up on the default ports, and Ctrl+C shutdown.

**Not tested - please be aware:**

* **No run on Windows 10/11**, and none with **Node.js v26.5.1** or **Python 3.11/3.12** (the development machine had Node 22.22 and Python 3.13). The Windows-specific parts - `taskkill` process-tree shutdown, the `py` launcher lookup, `winget` hints, default Tesseract install folders, `.venv\Scripts\python.exe` paths - are written carefully but have never been executed on Windows. If a script fails there, the manual commands in section 4 are the fallback, and `npm run dev` / `npm start` need no PowerShell.
* **Windows PowerShell 5.1** specifically (the scripts avoid PowerShell 7-only syntax and were parsed/run only with 7.4).
* **Camera capture on a real phone or webcam.** Only a synthetic camera stream was used.
* **Browsers other than Chromium**, and **real photographs** taken by you: all test images are synthetic or synthetic-plus-simulated-camera-distortion.
