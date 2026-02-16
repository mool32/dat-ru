// ============================================================
// DAT-RU: Тест дивергентного мышления — App Logic
// ============================================================

(function () {
    'use strict';

    // --- State ---
    const DIM = 300;
    let WORDS = [];           // string[] — sorted lemmas
    let WORD_SET = null;      // Set<string> — for fast lookup
    let FORMS = {};           // { form: lemma }
    let MATRIX = null;        // Int8Array — flat [N * 300]
    let WORD_INDEX = null;    // Map<string, number> — lemma → row index

    // Timer
    let timerInterval = null;
    let timerSeconds = 240; // 4 min

    // --- DOM refs ---
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    const loadingScreen = $('#loading-screen');
    const inputScreen = $('#input-screen');
    const resultScreen = $('#result-screen');
    const progressFill = $('#progress-fill');
    const progressText = $('#progress-text');
    const wordForm = $('#word-form');
    const submitBtn = $('#submit-btn');
    const validCountEl = $('#valid-count');
    const timerToggle = $('#timer-toggle');
    const timerDisplay = $('#timer-display');
    const scoreValue = $('#score-value');
    const scoreLabel = $('#score-label');
    const scaleMarker = $('#scale-marker');
    const heatmapContainer = $('#heatmap-container');
    const wordsUsedEl = $('#words-used');
    const shareBtn = $('#share-btn');
    const retryBtn = $('#retry-btn');

    // ============================================================
    // Data Loading
    // ============================================================

    async function loadData() {
        const totalSteps = 3;
        let loaded = 0;

        function updateProgress(step, detail) {
            loaded = step;
            const pct = Math.round((loaded / totalSteps) * 100);
            progressFill.style.width = pct + '%';
            progressText.textContent = detail || (pct + '%');
        }

        try {
            // 1. Load words.json
            updateProgress(0, 'Загрузка словаря...');
            const wordsResp = await fetch('data/words.json');
            WORDS = await wordsResp.json();
            WORD_SET = new Set(WORDS);
            WORD_INDEX = new Map();
            WORDS.forEach((w, i) => WORD_INDEX.set(w, i));
            updateProgress(1, 'Загрузка словоформ...');

            // 2. Load forms.json
            const formsResp = await fetch('data/forms.json');
            FORMS = await formsResp.json();
            updateProgress(2, 'Загрузка эмбеддингов...');

            // 3. Load matrix.bin
            const matrixResp = await fetch('data/matrix.bin');
            const buffer = await matrixResp.arrayBuffer();
            // Header: uint32 numWords, uint32 dim
            const header = new DataView(buffer, 0, 8);
            const numWords = header.getUint32(0, true);
            const dim = header.getUint32(4, true);

            if (dim !== DIM) {
                throw new Error(`Unexpected dimension: ${dim}, expected ${DIM}`);
            }

            MATRIX = new Int8Array(buffer, 8);

            if (MATRIX.length !== numWords * dim) {
                throw new Error(`Matrix size mismatch: ${MATRIX.length} vs ${numWords * dim}`);
            }

            updateProgress(3, 'Готово!');

            // Transition to input screen
            setTimeout(() => {
                loadingScreen.classList.add('hidden');
                inputScreen.classList.remove('hidden');
                // Focus first input
                const firstInput = document.querySelector('.word-input[data-index="0"]');
                if (firstInput) firstInput.focus();
            }, 300);

        } catch (err) {
            progressText.textContent = 'Ошибка загрузки: ' + err.message;
            progressFill.style.background = 'var(--red)';
            console.error('Load error:', err);
        }
    }

    // ============================================================
    // Word Normalization & Validation
    // ============================================================

    function normalizeWord(input) {
        let word = input.toLowerCase().trim();
        // Replace ё with е
        word = word.replace(/ё/g, 'е');
        // Check as lemma first
        if (WORD_SET.has(word)) return word;
        // Check as form
        if (FORMS[word]) return FORMS[word];
        return null;
    }

    function validateInput(input, index) {
        const raw = input.trim();

        if (!raw) return { valid: false, error: '', icon: '' };

        // Only Russian letters
        if (/[a-zA-Z]/.test(raw)) {
            return { valid: false, error: 'Только русские буквы', icon: '✗' };
        }

        // Single word
        if (/\s/.test(raw)) {
            return { valid: false, error: 'Одно слово', icon: '✗' };
        }

        // Only Cyrillic
        if (!/^[а-яёА-ЯЁ-]+$/.test(raw)) {
            return { valid: false, error: 'Только буквы', icon: '✗' };
        }

        const lemma = normalizeWord(raw);
        if (!lemma) {
            return { valid: false, error: 'Нет в словаре', icon: '✗' };
        }

        // Check for duplicates
        const inputs = $$('.word-input');
        for (let i = 0; i < inputs.length; i++) {
            if (i === index) continue;
            const otherLemma = normalizeWord(inputs[i].value);
            if (otherLemma && otherLemma === lemma) {
                return { valid: false, error: 'Повтор', icon: '✗', duplicate: true };
            }
        }

        return { valid: true, lemma, icon: '✓' };
    }

    // ============================================================
    // UI: Validation
    // ============================================================

    function updateValidation(input) {
        const index = parseInt(input.dataset.index);
        const wrapper = input.closest('.word-input-wrapper');
        const iconEl = wrapper.querySelector('.validation-icon');
        const msgEl = wrapper.querySelector('.validation-msg');

        const result = validateInput(input.value, index);

        wrapper.classList.remove('valid', 'invalid', 'duplicate');
        iconEl.textContent = result.icon;
        msgEl.textContent = result.error || '';

        if (!input.value.trim()) {
            // empty — neutral
        } else if (result.valid) {
            wrapper.classList.add('valid');
            iconEl.style.color = 'var(--green)';
        } else if (result.duplicate) {
            wrapper.classList.add('duplicate');
            iconEl.style.color = 'var(--orange)';
        } else {
            wrapper.classList.add('invalid');
            iconEl.style.color = 'var(--red)';
        }

        updateSubmitButton();
    }

    function updateAllValidations() {
        $$('.word-input').forEach(input => updateValidation(input));
    }

    function updateSubmitButton() {
        const validCount = getValidWords().length;
        validCountEl.textContent = validCount;
        submitBtn.disabled = validCount < 7;
    }

    function getValidWords() {
        const result = [];
        const seen = new Set();
        const inputs = $$('.word-input');

        for (const input of inputs) {
            const lemma = normalizeWord(input.value);
            if (lemma && !seen.has(lemma)) {
                seen.add(lemma);
                result.push(lemma);
            }
        }
        return result;
    }

    // ============================================================
    // DAT Algorithm
    // ============================================================

    function getVector(wordIndex) {
        const offset = wordIndex * DIM;
        return MATRIX.subarray(offset, offset + DIM);
    }

    function cosineDistance(a, b) {
        let dot = 0, normA = 0, normB = 0;
        for (let i = 0; i < DIM; i++) {
            dot += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        if (normA === 0 || normB === 0) return 0;
        const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));
        return 1 - similarity;
    }

    function calculateDAT(lemmas) {
        // Take first 7 valid unique words
        const words = lemmas.slice(0, 7);
        if (words.length < 7) return null;

        const indices = words.map(w => WORD_INDEX.get(w));
        const vectors = indices.map(i => getVector(i));

        // All 21 pairs
        let totalDist = 0;
        let pairCount = 0;
        const distances = []; // for heatmap

        for (let i = 0; i < vectors.length; i++) {
            for (let j = i + 1; j < vectors.length; j++) {
                const dist = cosineDistance(vectors[i], vectors[j]);
                totalDist += dist;
                pairCount++;
                distances.push({ i, j, dist });
            }
        }

        const score = (totalDist / pairCount) * 100;
        return { score, words, distances };
    }

    // ============================================================
    // UI: Results
    // ============================================================

    function getScoreLabel(score) {
        if (score < 65) return 'Ниже среднего. Ты думаешь привычными категориями.';
        if (score < 78) return 'Средне. Как большинство людей.';
        if (score < 90) return 'Выше среднего! Неплохое дивергентное мышление.';
        if (score < 100) return 'Отлично! Ты в верхних 15%.';
        return 'Исключительно! Такие баллы — редкость.';
    }

    function showResults(result) {
        const { score, words, distances } = result;

        // Score
        scoreValue.textContent = score.toFixed(1);
        scoreLabel.textContent = getScoreLabel(score);

        // Scale marker (0–120 range mapped to 0–100%)
        const pct = Math.min(Math.max(score / 120 * 100, 0), 100);
        scaleMarker.style.left = pct + '%';

        // Words used
        wordsUsedEl.textContent = words.join(', ');

        // Heatmap
        buildHeatmap(words, distances);

        // Show screen
        inputScreen.classList.add('hidden');
        resultScreen.classList.remove('hidden');
        window.scrollTo(0, 0);
    }

    function buildHeatmap(words, distances) {
        const n = words.length;

        // Build distance matrix
        const matrix = Array.from({ length: n }, () => Array(n).fill(0));
        for (const { i, j, dist } of distances) {
            matrix[i][j] = dist;
            matrix[j][i] = dist;
        }

        // Find min/max for coloring (excluding diagonal)
        let minDist = Infinity, maxDist = -Infinity;
        for (const { dist } of distances) {
            minDist = Math.min(minDist, dist);
            maxDist = Math.max(maxDist, dist);
        }

        // Build table
        const table = document.createElement('table');
        table.className = 'heatmap-table';

        // Header row
        const thead = document.createElement('tr');
        thead.innerHTML = '<th></th>';
        words.forEach(w => {
            const th = document.createElement('th');
            th.textContent = w.length > 7 ? w.slice(0, 6) + '...' : w;
            th.title = w;
            thead.appendChild(th);
        });
        table.appendChild(thead);

        // Data rows
        for (let i = 0; i < n; i++) {
            const tr = document.createElement('tr');
            const rowHeader = document.createElement('th');
            rowHeader.className = 'row-header';
            rowHeader.textContent = words[i].length > 7 ? words[i].slice(0, 6) + '...' : words[i];
            rowHeader.title = words[i];
            tr.appendChild(rowHeader);

            for (let j = 0; j < n; j++) {
                const td = document.createElement('td');
                if (i === j) {
                    td.style.background = 'var(--surface-2)';
                    td.textContent = '—';
                    td.style.color = 'var(--text-muted)';
                } else {
                    const dist = matrix[i][j];
                    const normalized = maxDist > minDist
                        ? (dist - minDist) / (maxDist - minDist)
                        : 0.5;

                    // Color: dark purple (close) → bright green (far)
                    const r = Math.round(40 + (0 - 40) * normalized);
                    const g = Math.round(20 + (184 - 20) * normalized);
                    const b = Math.round(80 + (148 - 80) * normalized);

                    td.style.background = `rgb(${r}, ${g}, ${b})`;
                    td.textContent = (dist * 100).toFixed(0);
                    td.style.color = normalized > 0.5 ? '#000' : '#fff';
                    td.title = `${words[i]} ↔ ${words[j]}: ${(dist * 100).toFixed(1)}`;
                }
                tr.appendChild(td);
            }
            table.appendChild(tr);
        }

        heatmapContainer.innerHTML = '';
        heatmapContainer.appendChild(table);
    }

    // ============================================================
    // Timer
    // ============================================================

    function startTimer() {
        timerSeconds = 240;
        timerDisplay.classList.remove('hidden', 'warning', 'danger');
        timerToggle.classList.add('active');
        updateTimerDisplay();

        timerInterval = setInterval(() => {
            timerSeconds--;
            if (timerSeconds <= 0) {
                clearInterval(timerInterval);
                timerInterval = null;
                timerDisplay.textContent = '0:00';
                timerDisplay.classList.add('danger');
                // Auto-submit if enough words
                if (getValidWords().length >= 7) {
                    handleSubmit();
                }
                return;
            }
            updateTimerDisplay();
        }, 1000);
    }

    function stopTimer() {
        if (timerInterval) {
            clearInterval(timerInterval);
            timerInterval = null;
        }
        timerDisplay.classList.add('hidden');
        timerDisplay.classList.remove('warning', 'danger');
        timerToggle.classList.remove('active');
    }

    function updateTimerDisplay() {
        const min = Math.floor(timerSeconds / 60);
        const sec = timerSeconds % 60;
        timerDisplay.textContent = `${min}:${sec.toString().padStart(2, '0')}`;

        timerDisplay.classList.remove('warning', 'danger');
        if (timerSeconds <= 30) {
            timerDisplay.classList.add('danger');
        } else if (timerSeconds <= 60) {
            timerDisplay.classList.add('warning');
        }
    }

    // ============================================================
    // Share
    // ============================================================

    function shareResult() {
        const score = scoreValue.textContent;
        const text = `Мой результат теста дивергентного мышления (DAT-RU): ${score} баллов!\n\nСреднее — 78, ChatGPT — ~85, Claude — ~87.\n\nПройди тест: ${window.location.href}`;

        if (navigator.share) {
            navigator.share({ title: 'DAT-RU — Мой результат', text })
                .catch(() => copyToClipboard(text));
        } else {
            copyToClipboard(text);
        }
    }

    function copyToClipboard(text) {
        navigator.clipboard.writeText(text).then(() => {
            showToast('Скопировано в буфер обмена!');
        }).catch(() => {
            showToast('Не удалось скопировать');
        });
    }

    function showToast(message) {
        let toast = document.querySelector('.toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.className = 'toast';
            document.body.appendChild(toast);
        }
        toast.textContent = message;
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 2500);
    }

    // ============================================================
    // Submit
    // ============================================================

    function handleSubmit(e) {
        if (e) e.preventDefault();

        const validWords = getValidWords();
        if (validWords.length < 7) return;

        stopTimer();

        const result = calculateDAT(validWords);
        if (!result) return;

        showResults(result);
    }

    // ============================================================
    // Reset
    // ============================================================

    function resetForm() {
        resultScreen.classList.add('hidden');
        inputScreen.classList.remove('hidden');

        $$('.word-input').forEach(input => {
            input.value = '';
        });
        updateAllValidations();
        stopTimer();
        window.scrollTo(0, 0);
        document.querySelector('.word-input[data-index="0"]').focus();
    }

    // ============================================================
    // Event Listeners
    // ============================================================

    function init() {
        // Word input events
        $$('.word-input').forEach(input => {
            input.addEventListener('input', () => {
                updateValidation(input);
                // Also re-validate others (for duplicate detection)
                updateAllValidations();
            });

            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    const idx = parseInt(input.dataset.index);
                    const next = document.querySelector(`.word-input[data-index="${idx + 1}"]`);
                    if (next) {
                        next.focus();
                    } else if (!submitBtn.disabled) {
                        handleSubmit();
                    }
                }
            });
        });

        // Form submit
        wordForm.addEventListener('submit', handleSubmit);

        // Timer
        timerToggle.addEventListener('click', () => {
            if (timerInterval) {
                stopTimer();
            } else {
                startTimer();
            }
        });

        // Share
        shareBtn.addEventListener('click', shareResult);

        // Retry
        retryBtn.addEventListener('click', resetForm);

        // Load data
        loadData();
    }

    // Start
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
