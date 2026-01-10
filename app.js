/**
 * SmartPresent Core V4.0 (Strict "Go To" Logic)
 */

const DB_NAME = 'SmartPresentDB';
const STORE_NAME = 'PresentationStore';
const CHANNEL_NAME = 'SmartPresent_Sync';

// --- 1. UTILITIES & DATABASE ---
const dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = (e) => e.target.result.createObjectStore(STORE_NAME);
    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror = (e) => reject(e);
});

async function saveFile(key, val) {
    const db = await dbPromise;
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(val, key);
        tx.oncomplete = () => resolve();
    });
}

async function getFile(key) {
    const db = await dbPromise;
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(key);
        req.onsuccess = () => resolve(req.result);
    });
}

// --- 2. TEXT PROCESSING UTILS ---
function levenshteinDistance(a, b) {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1)
                );
            }
        }
    }
    return matrix[b.length][a.length];
}

// strictFuzzy: Only returns true if the words are very close
function isMatch(target, input) {
    target = target.toLowerCase();
    input = input.toLowerCase();
    
    // Exact match
    if (input === target) return true;
    
    // Levenshtein (allow 1 error per 5 letters)
    const dist = levenshteinDistance(target, input);
    return dist <= Math.floor(target.length / 5);
}

// --- 3. PAGE LOGIC ---
document.addEventListener('DOMContentLoaded', async () => {
    const page = document.body.dataset.page;

    // --- UPLOAD PAGE ---
    if (page === 'upload') {
        const dropZone = document.querySelector('.drop-zone');
        const fileInput = document.getElementById('fileUpload');
        
        dropZone.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', () => {
            if(fileInput.files.length) document.getElementById('fileName').innerText = fileInput.files[0].name;
        });

        document.getElementById('uploadForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const file = fileInput.files[0];
            const owner = document.getElementById('ownerName').value;
            if(!file) return alert("Please select a file");

            const btn = e.target.querySelector('button');
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
            
            const buffer = await file.arrayBuffer();
            await saveFile('presentationBlob', buffer);
            await saveFile('meta', { owner, fileName: file.name });
            window.location.href = 'configure.html';
        });
    }

    // --- CONFIGURE PAGE ---
    if (page === 'configure') {
        const buffer = await getFile('presentationBlob');
        if(!buffer) return window.location.href = 'index.html';

        const pdfjsLib = window['pdfjs-dist/build/pdf'];
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';
        const pdf = await pdfjsLib.getDocument(buffer).promise;
        const container = document.getElementById('slidesContainer');
        const configData = [];

        for (let i = 1; i <= pdf.numPages; i++) {
            const pageData = await pdf.getPage(i);
            const viewport = pageData.getViewport({ scale: 0.4 });
            const div = document.createElement('div');
            div.className = 'slide-card glass-panel';
            
            const canvas = document.createElement('canvas');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            await pageData.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

            div.innerHTML = `
                <div class="thumb-wrapper"><span class="slide-badge">Slide ${i}</span></div>
                <div class="input-group" style="margin-bottom:10px">
                    <label style="font-size:0.8rem; color:#94a3b8">Voice Name (e.g. "Financials")</label>
                    <input type="text" class="cmd-input" value="Slide ${i}">
                </div>
                <div class="input-group">
                    <label style="font-size:0.8rem; color:#94a3b8">Duration (sec)</label>
                    <input type="number" class="dur-input" value="20">
                </div>
            `;
            div.querySelector('.thumb-wrapper').appendChild(canvas);
            container.appendChild(div);
            configData.push({ page: i });
        }

        document.getElementById('saveBtn').addEventListener('click', async () => {
            const cmds = document.querySelectorAll('.cmd-input');
            const durs = document.querySelectorAll('.dur-input');
            const finalConfig = configData.map((s, i) => ({
                page: s.page,
                command: cmds[i].value, // User defined name
                duration: parseInt(durs[i].value)
            }));
            await saveFile('config', finalConfig);
            window.location.href = 'presenter.html';
        });
    }

    // --- PRESENTER PAGE (STRICT VOICE) ---
    if (page === 'presenter') {
        const config = await getFile('config');
        const buffer = await getFile('presentationBlob');
        const channel = new BroadcastChannel(CHANNEL_NAME);
        
        const pdfjsLib = window['pdfjs-dist/build/pdf'];
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';
        const pdf = await pdfjsLib.getDocument(buffer).promise;

        // Variables
        let currentIndex = 0;
        let timerInt;
        let timeLeft = 0;
        let isRunning = false;
        let isPaused = false;
        let recognition = null;

        // Elements
        const img = document.getElementById('slideImg');
        const timerBar = document.getElementById('timerProgress');
        const logBox = document.getElementById('logContent');
        const nextInfo = document.getElementById('nextInfo');
        const micWidget = document.getElementById('micWidget');
        const micText = document.getElementById('micStatusText');
        const btnStart = document.getElementById('btnStart');

        // 1. RENDER LOGIC
        async function renderSlide(index) {
            if(index < 0) index = 0;
            if(index >= config.length) index = config.length - 1;
            currentIndex = index;

            const p = await pdf.getPage(config[index].page);
            const vp = p.getViewport({ scale: 2.0 });
            const cvs = document.createElement('canvas');
            cvs.width = vp.width; cvs.height = vp.height;
            await p.render({ canvasContext: cvs.getContext('2d'), viewport: vp }).promise;
            
            img.src = cvs.toDataURL();
            channel.postMessage({ type: 'CHANGE_SLIDE', img: cvs.toDataURL() });

            // Next Info
            if(currentIndex + 1 < config.length) {
                nextInfo.innerHTML = `<strong>Next:</strong> ${config[currentIndex+1].command}`;
            } else {
                nextInfo.innerHTML = `<strong>End of Presentation</strong>`;
            }

            if (isRunning) resetTimer(config[index].duration);
        }

        // 2. TIMER LOGIC
        function resetTimer(seconds) {
            clearInterval(timerInt);
            timeLeft = seconds;
            const total = seconds;
            timerInt = setInterval(() => {
                if(!isPaused && isRunning) {
                    timeLeft--;
                    timerBar.style.width = `${((total - timeLeft)/total)*100}%`;
                    if(timeLeft <= 0) {
                        clearInterval(timerInt);
                        // Optional: Auto-advance on timeout? User usually prefers manual for voice.
                        // Uncomment next line to auto-advance:
                        // if(currentIndex < config.length - 1) renderSlide(currentIndex + 1);
                    }
                }
            }, 1000);
        }

        function log(text, type='neutral') {
            const div = document.createElement('div');
            div.className = 'log-entry';
            div.innerText = text;
            if(type === 'success') div.style.borderColor = '#10b981'; // Green
            if(type === 'cmd') { div.style.borderColor = '#6366f1'; div.style.fontWeight='bold'; } // Blue
            logBox.appendChild(div);
            logBox.scrollTop = logBox.scrollHeight;
        }

        function updateMicUI(active) {
            if(active) {
                micWidget.classList.add('listening');
                micText.innerText = "Listening...";
                micText.style.color = "#ef4444";
            } else {
                micWidget.classList.remove('listening');
                micText.innerText = "Mic Standby";
                micText.style.color = "#94a3b8";
            }
        }

        // 3. STRICT COMMAND PARSER
        function processVoice(transcript) {
            const clean = transcript.toLowerCase().trim();
            
            // --- A. BASIC COMMANDS (Must use specific phrases) ---
            
            // NEXT: Must say "Next Slide" or "Go Next"
            if (clean.includes('next slide') || clean === 'go next' || clean === 'next page') {
                document.getElementById('btnNext').click();
                log(`>> CMD: Next Slide`, 'cmd');
                return;
            }

            // PREV: Must say "Previous Slide" or "Go Back"
            if (clean.includes('previous slide') || clean === 'go back' || clean === 'last slide') {
                document.getElementById('btnPrev').click();
                log(`>> CMD: Previous Slide`, 'cmd');
                return;
            }

            // STOP/PAUSE
            if (clean === 'pause presentation' || clean === 'stop presentation' || clean === 'pause') {
                if(!isPaused) document.getElementById('btnPause').click();
                log(`>> CMD: Pause`, 'cmd');
                return;
            }

            // START/RESUME
            if (clean === 'start presentation' || clean === 'resume presentation') {
                if(isPaused || !isRunning) document.getElementById('btnStart').click();
                log(`>> CMD: Start/Resume`, 'cmd');
                return;
            }

            // --- B. "GO TO" NAVIGATION LOGIC ---
            // We look specifically for the prefix "go to"
            if (clean.startsWith('go to')) {
                // Extract the target (e.g., "go to financials" -> "financials")
                const target = clean.replace('go to', '').trim();
                
                if (target.length > 0) {
                    // Try to match specific slide names
                    const match = config.find(c => isMatch(c.command, target));
                    
                    if(match) {
                        log(`>> Jumping to: ${match.command}`, 'cmd');
                        renderSlide(config.indexOf(match));
                    } else {
                        log(`(Unrecognized Slide: "${target}")`);
                    }
                }
                return;
            }
            
            // If we are here, the user is just talking normally.
            // Do NOT trigger anything.
            log(`(Ignored): "${transcript}"`);
        }

        // 4. VOICE ENGINE
        function initSpeech() {
            const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
            if(!Speech) return alert("Use Google Chrome for Voice features.");

            recognition = new Speech();
            recognition.continuous = true;
            recognition.interimResults = false;
            recognition.lang = 'en-US';

            recognition.onstart = () => updateMicUI(true);
            recognition.onend = () => {
                updateMicUI(false);
                // Aggressively restart mic if running
                if (isRunning) {
                    setTimeout(() => { try{recognition.start()}catch(e){} }, 500); 
                }
            };

            recognition.onerror = (e) => {
                console.log("Mic Error", e.error);
                if(e.error === 'not-allowed') {
                    log("Mic Blocked. Click 'Allow' in URL bar.", 'error');
                    isRunning = false;
                }
            };

            recognition.onresult = (e) => {
                const transcript = e.results[e.results.length-1][0].transcript;
                processVoice(transcript);
            };
        }

        // 5. EVENTS & INIT
        btnStart.onclick = function() {
            if(isRunning && !isPaused) return;

            isRunning = true; isPaused = false;
            this.classList.add('active');
            document.getElementById('btnPause').classList.remove('active');
            
            renderSlide(currentIndex);
            
            // Force Start Mic
            if(!recognition) initSpeech();
            try { recognition.start(); } catch(e) { console.log("Mic already on"); }
            
            log("Presentation Active - Mic Listening...");
        };

        document.getElementById('btnPause').onclick = function() {
            isPaused = !isPaused;
            this.classList.toggle('active', isPaused);
            log(isPaused ? "Paused" : "Resumed");
        };

        document.getElementById('btnPrev').onclick = () => renderSlide(currentIndex - 1);
        document.getElementById('btnNext').onclick = () => renderSlide(currentIndex + 1);
        document.getElementById('btnOpenAudience').onclick = () => window.open('presentation.html', 'Audience', 'width=1280,height=720');

        // --- AUTO START ATTEMPT ---
        renderSlide(0);
        
        // Try to start mic immediately (Browser might block this without click, but we try)
        initSpeech();
        setTimeout(() => {
             // We virtually click "Start" to trigger permission prompt immediately
            btnStart.click(); 
        }, 500);
    }

    // --- AUDIENCE PAGE ---
    if (page === 'audience') {
        const channel = new BroadcastChannel(CHANNEL_NAME);
        const img = document.getElementById('audienceImg');
        const overlay = document.getElementById('fsOverlay');

        overlay.addEventListener('click', () => {
            document.documentElement.requestFullscreen().catch(console.log);
            overlay.style.display = 'none';
        });

        channel.onmessage = (e) => {
            if(e.data.type === 'CHANGE_SLIDE') {
                img.style.opacity = 0;
                setTimeout(() => { img.src = e.data.img; img.style.opacity = 1; }, 200);
            }
        };
    }
});
