const DB_NAME = 'SmartPresentDB';
const STORE_NAME = 'PresentationStore';
const CHANNEL_NAME = 'SmartPresent_Sync';

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

function levenshteinDistance(a, b) {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1));
            }
        }
    }
    return matrix[b.length][a.length];
}

function isMatch(target, input) {
    target = target.toLowerCase();
    input = input.toLowerCase();
    if (input === target) return true;
    const dist = levenshteinDistance(target, input);
    return dist <= Math.floor(target.length / 5);
}

document.addEventListener('DOMContentLoaded', async () => {
    const page = document.body.dataset.page;

    if (page === 'upload') {
        const dropZone = document.querySelector('.drop-zone');
        const fileInput = document.getElementById('fileUpload');
        dropZone.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', () => { if(fileInput.files.length) document.getElementById('fileName').innerText = fileInput.files[0].name; });

        document.getElementById('uploadForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const file = fileInput.files[0];
            const owner = document.getElementById('ownerName').value;
            if(!file) return alert("Please select a file");
            e.target.querySelector('button').innerHTML = 'Processing...';
            const buffer = await file.arrayBuffer();
            await saveFile('presentationBlob', buffer);
            await saveFile('meta', { owner, fileName: file.name });
            await saveFile('currentIndex', 0);
            window.location.href = 'configure.html';
        });
    }

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
            canvas.width = viewport.width; canvas.height = viewport.height;
            await pageData.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

            div.innerHTML = `
                <div class="thumb-wrapper"><span class="slide-badge">Slide ${i}</span></div>
                <div class="input-group" style="margin-bottom:10px">
                    <label style="font-size:0.8rem; color:#94a3b8">Voice Name</label>
                    <input type="text" class="cmd-input" value="Slide ${i}">
                </div>
                <div class="input-group">
                    <label style="font-size:0.8rem; color:#94a3b8">Duration (sec)</label>
                    <input type="number" class="dur-input" value="10"> 
                </div>
            `;
            div.querySelector('.thumb-wrapper').appendChild(canvas);
            container.appendChild(div);
            configData.push({ page: i });
        }

        document.getElementById('saveBtn').addEventListener('click', async () => {
            const cmds = document.querySelectorAll('.cmd-input');
            const durs = document.querySelectorAll('.dur-input');
            const finalConfig = configData.map((s, i) => ({ page: s.page, command: cmds[i].value, duration: parseInt(durs[i].value) }));
            await saveFile('config', finalConfig);
            window.location.href = 'presenter.html';
        });
    }

    if (page === 'presenter') {
        const config = await getFile('config');
        const buffer = await getFile('presentationBlob');
        const channel = new BroadcastChannel(CHANNEL_NAME);
        
        const pdfjsLib = window['pdfjs-dist/build/pdf'];
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';
        const pdf = await pdfjsLib.getDocument(buffer).promise;

        let currentIndex = 0;
        let timerInt;
        let timeLeft = 0;
        let isRunning = false;
        let isPaused = false;
        let recognition = null;

        const img = document.getElementById('slideImg');
        const timerBar = document.getElementById('timerProgress');
        const logBox = document.getElementById('logContent');
        const nextInfo = document.getElementById('nextInfo');
        const micWidget = document.getElementById('micWidget');
        const micText = document.getElementById('micStatusText');
        const btnStart = document.getElementById('btnStart');

        async function renderSlide(index) {
            if(index >= config.length) index = 0; 
            if(index < 0) index = config.length - 1;
            currentIndex = index;

            await saveFile('currentIndex', currentIndex);

            const p = await pdf.getPage(config[index].page);
            const vp = p.getViewport({ scale: 2.0 });
            const cvs = document.createElement('canvas');
            cvs.width = vp.width; cvs.height = vp.height;
            await p.render({ canvasContext: cvs.getContext('2d'), viewport: vp }).promise;
            img.src = cvs.toDataURL();
            
            channel.postMessage({ type: 'CHANGE_SLIDE', index: currentIndex });

            if(currentIndex + 1 < config.length) nextInfo.innerHTML = `<strong>Next:</strong> ${config[currentIndex+1].command}`;
            else nextInfo.innerHTML = `<strong>Next:</strong> Loop to Start`;

            if (isRunning) resetTimer(config[index].duration);
        }

        function resetTimer(seconds) {
            clearInterval(timerInt);
            timeLeft = seconds;
            const total = seconds;
            
            timerInt = setInterval(() => {
                if(!isPaused && isRunning) {
                    timeLeft--;
                    timerBar.style.width = `${((total - timeLeft) / total) * 100}%`;
                    if (timeLeft <= 0) {
                        clearInterval(timerInt);
                        renderSlide(currentIndex + 1); 
                    }
                }
            }, 1000);
        }

        function log(text, type='neutral') {
            const div = document.createElement('div');
            div.className = 'log-entry';
            div.innerText = text;
            if(type === 'cmd') { div.style.borderColor = '#6366f1'; div.style.fontWeight='bold'; }
            logBox.appendChild(div);
            logBox.scrollTop = logBox.scrollHeight;
        }

        function handleAction(action, payload) {
            if (action === 'next') { document.getElementById('btnNext').click(); log(">> CMD: Next", 'cmd'); }
            if (action === 'prev') { document.getElementById('btnPrev').click(); log(">> CMD: Prev", 'cmd'); }
            if (action === 'pause') { if(!isPaused) document.getElementById('btnPause').click(); log(">> CMD: Pause", 'cmd'); }
            if (action === 'start') { if(isPaused || !isRunning) document.getElementById('btnStart').click(); log(">> CMD: Start", 'cmd'); }
            if (action === 'goto') {
                const match = config.find(c => isMatch(c.command, payload));
                if(match) { renderSlide(config.indexOf(match)); log(`>> CMD: Jump to ${payload}`, 'cmd'); }
            }
        }

        channel.onmessage = (e) => {
            if (e.data.type === 'REMOTE_CMD') {
                log(`[Audience Remote]: ${e.data.action}`);
                handleAction(e.data.action, e.data.payload);
            }
        };

        function processVoice(transcript) {
            const clean = transcript.toLowerCase().trim();
            if (clean.includes('next slide') || clean === 'go next') handleAction('next');
            else if (clean.includes('previous slide') || clean === 'go back') handleAction('prev');
            else if (clean === 'pause presentation' || clean === 'pause') handleAction('pause');
            else if (clean === 'start presentation' || clean === 'resume presentation') handleAction('start');
            else if (clean.startsWith('go to')) handleAction('goto', clean.replace('go to', '').trim());
            else log(`(Ignored): "${transcript}"`);
        }

        function initSpeech() {
            const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
            if(!Speech) return;
            recognition = new Speech();
            recognition.continuous = true; recognition.interimResults = false; recognition.lang = 'en-US';
            recognition.onstart = () => { micWidget.classList.add('listening'); micText.innerText = "Listening..."; micText.style.color = "#ef4444"; };
            recognition.onend = () => { micWidget.classList.remove('listening'); micText.innerText = "Standby"; micText.style.color = "#94a3b8"; if(isRunning) try{recognition.start()}catch(e){} };
            recognition.onresult = (e) => processVoice(e.results[e.results.length-1][0].transcript);
        }

        btnStart.onclick = function() {
            if(isRunning && !isPaused) return;
            isRunning = true; isPaused = false;
            this.classList.add('active'); document.getElementById('btnPause').classList.remove('active');
            renderSlide(currentIndex);
            if(!recognition) initSpeech();
            try { recognition.start(); } catch(e) {}
        };
        document.getElementById('btnPause').onclick = function() { isPaused = !isPaused; this.classList.toggle('active', isPaused); };
        document.getElementById('btnPrev').onclick = () => renderSlide(currentIndex - 1);
        document.getElementById('btnNext').onclick = () => renderSlide(currentIndex + 1);
        document.getElementById('btnOpenAudience').onclick = () => window.open('presentation.html', 'Audience', 'width=1280,height=720');

        renderSlide(0);
        setTimeout(() => btnStart.click(), 500);
    }

    if (page === 'audience') {
        const config = await getFile('config');
        const buffer = await getFile('presentationBlob');
        const channel = new BroadcastChannel(CHANNEL_NAME);
        
        const pdfjsLib = window['pdfjs-dist/build/pdf'];
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';
        const pdf = await pdfjsLib.getDocument(buffer).promise;

        const img = document.getElementById('audienceImg');
        const overlay = document.getElementById('fsOverlay');
        const micIcon = document.getElementById('audienceMicStatus');

        let lastIndex = -99;

        async function renderLocalSlide(index) {
            if(index === lastIndex) return;
            lastIndex = index;

            const p = await pdf.getPage(config[index].page);
            const vp = p.getViewport({ scale: 2.0 });
            const cvs = document.createElement('canvas');
            cvs.width = vp.width; cvs.height = vp.height;
            await p.render({ canvasContext: cvs.getContext('2d'), viewport: vp }).promise;
            
            img.style.opacity = 0;
            setTimeout(() => {
                img.src = cvs.toDataURL();
                img.style.opacity = 1;
            }, 100);
        }

        const initIndex = await getFile('currentIndex');
        if (initIndex !== undefined) renderLocalSlide(initIndex);
        else renderLocalSlide(0);

        channel.onmessage = (e) => {
            if(e.data.type === 'CHANGE_SLIDE') {
                renderLocalSlide(e.data.index);
            }
        };

        setInterval(async () => {
            const dbIndex = await getFile('currentIndex');
            if (dbIndex !== undefined && dbIndex !== lastIndex) {
                console.log("Resyncing from DB...");
                renderLocalSlide(dbIndex);
            }
        }, 1000);

        function initRemoteVoice() {
            const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
            if(!Speech) return;
            const recognition = new Speech();
            recognition.continuous = true; recognition.interimResults = false; recognition.lang = 'en-US';
            
            recognition.onstart = () => { micIcon.innerHTML = '<i class="fas fa-microphone" style="color:red"></i>'; };
            recognition.onend = () => { micIcon.innerHTML = '<i class="fas fa-microphone-slash"></i>'; try{recognition.start()}catch(e){} };
            
            recognition.onresult = (e) => {
                const clean = e.results[e.results.length-1][0].transcript.toLowerCase().trim();
                console.log("Audience heard:", clean);
                if (clean.includes('next slide') || clean === 'go next') channel.postMessage({ type: 'REMOTE_CMD', action: 'next' });
                else if (clean.includes('previous slide') || clean === 'go back') channel.postMessage({ type: 'REMOTE_CMD', action: 'prev' });
                else if (clean === 'pause') channel.postMessage({ type: 'REMOTE_CMD', action: 'pause' });
                else if (clean.startsWith('go to')) channel.postMessage({ type: 'REMOTE_CMD', action: 'goto', payload: clean.replace('go to', '').trim() });
            };
            try { recognition.start(); } catch(e){}
        }

        overlay.addEventListener('click', () => {
            document.documentElement.requestFullscreen().catch(console.log);
            overlay.style.display = 'none';
            initRemoteVoice();
        });
    }
});
