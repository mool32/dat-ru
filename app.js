// ============================================================
// DAT-RU: Тест дивергентного мышления — App Logic
// ============================================================

(function () {
    'use strict';

    // --- Config ---
    const DIM = 300;
    // Google Apps Script endpoint for data collection
    // Замени на свой URL после создания Apps Script
    const COLLECT_URL = 'https://script.google.com/macros/s/AKfycbwUxyjCHgNBInDBiFFFxrmplH1iZvdNOleRTIL85x_hLndAt959bMHw_aNsds9rPkf6MA/exec';

    // --- State ---
    let WORDS = [];           // string[] — sorted lemmas
    let WORD_SET = null;      // Set<string> — for fast lookup
    let FORMS = {};           // { form: lemma }
    let MATRIX = null;        // Int8Array — flat [N * 300]
    let WORD_INDEX = null;    // Map<string, number> — lemma → row index

    // Timer
    let timerInterval = null;
    let timerSeconds = 180; // 3 min
    let timerStartedAt = null; // timestamp when timer started
    let timerPaused = false;

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
                // Auto-start timer
                startTimer();
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

    /**
     * Коррекция балла: степенная функция.
     *   adjusted = a · (raw/100)^p + b
     *
     * Калибровка (5000 случайных наборов по 7 слов):
     *   - медиана случайных (raw ~87) → 78 (как в англ. DAT)
     *   - связанные слова (raw ~52) → ~54
     *   - хорошо далёкие (raw ~95) → ~89
     *   - набрать 100 → нужен raw ~102 (почти невозможно)
     *
     * Гладкая, монотонная, без переломов.
     */
    function adjustScore(rawScore) {
        const x = rawScore / 100;
        return 47.4548 * Math.pow(x, 3.3820) + 48.5157;
    }

    function calculateDAT(lemmas) {
        // Score uses first 7 words (per original DAT spec)
        const scoreWords = lemmas.slice(0, 7);
        if (scoreWords.length < 7) return null;

        const scoreIndices = scoreWords.map(w => WORD_INDEX.get(w));
        const scoreVectors = scoreIndices.map(i => getVector(i));

        // 21 pairs for scoring
        let totalDist = 0;
        let pairCount = 0;
        const distances = [];

        for (let i = 0; i < scoreVectors.length; i++) {
            for (let j = i + 1; j < scoreVectors.length; j++) {
                const dist = cosineDistance(scoreVectors[i], scoreVectors[j]);
                totalDist += dist;
                pairCount++;
                distances.push({ i, j, dist });
            }
        }

        const rawScore = (totalDist / pairCount) * 100;
        const score = adjustScore(rawScore);

        return { score, words: scoreWords, distances };
    }

    // ============================================================
    // UI: Results
    // ============================================================

    function getScoreLabel(score) {
        if (score < 60) return 'Низкий балл. Слова слишком связаны между собой.';
        if (score < 70) return 'Ниже среднего. Есть куда расти.';
        if (score < 78) return 'Чуть ниже среднего. Неплохо!';
        if (score < 83) return 'Выше среднего! Хорошее дивергентное мышление.';
        if (score < 90) return 'Отлично! Высокая вербальная креативность.';
        return 'Исключительно! Такие баллы — редкость.';
    }

    function showResults(result) {
        const { score, words, distances } = result;

        // Score
        scoreValue.textContent = score.toFixed(1);
        scoreLabel.textContent = getScoreLabel(score);

        // Scale marker (0–110 range mapped to 0–100%)
        const pct = Math.min(Math.max(score / 110 * 100, 0), 100);
        scaleMarker.style.left = pct + '%';

        // Heatmap for the 7 scoring words
        buildHeatmap(words, distances);

        // Collect data (silent, non-blocking)
        collectResult(score, words);

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
        timerSeconds = 180;
        timerPaused = false;
        timerStartedAt = Date.now();
        resumeTimer();
    }

    function resumeTimer() {
        timerPaused = false;
        timerDisplay.classList.remove('warning', 'danger');
        timerToggle.classList.add('active');
        timerToggle.textContent = '⏸';
        setInputsDisabled(false);
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

    function pauseTimer() {
        if (timerInterval) {
            clearInterval(timerInterval);
            timerInterval = null;
        }
        timerPaused = true;
        timerToggle.classList.remove('active');
        timerToggle.textContent = '▶';
        setInputsDisabled(true);
    }

    function stopTimer() {
        if (timerInterval) {
            clearInterval(timerInterval);
            timerInterval = null;
        }
        timerPaused = false;
        timerDisplay.classList.remove('warning', 'danger');
        timerToggle.classList.remove('active');
        timerToggle.textContent = '▶';
        setInputsDisabled(false);
    }

    function setInputsDisabled(disabled) {
        $$('.word-input').forEach(input => {
            input.disabled = disabled;
        });
        submitBtn.disabled = disabled || getValidWords().length < 7;
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
    // Data Collection
    // ============================================================

    function collectResult(score, words) {
        if (!COLLECT_URL) return; // не настроен — пропускаем

        const timeSpent = timerStartedAt
            ? Math.round((Date.now() - timerStartedAt) / 1000)
            : null;

        const payload = {
            score: score,
            words: words,
            timeSpent: timeSpent,
            userAgent: navigator.userAgent
        };

        // Тихая отправка — не мешает пользователю
        fetch(COLLECT_URL, {
            method: 'POST',
            mode: 'no-cors',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).catch(() => {
            // Ошибка — молча игнорируем
        });
    }

    // ============================================================
    // Share
    // ============================================================

    function shareResult() {
        const score = scoreValue.textContent;
        const text = `Мой результат теста на вербальную креативность (DAT-RU): ${score} баллов!\n\nСреднее — ~78. Большинство людей набирают от 70 до 85.\n\nПройди тест: ${window.location.href}`;

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
        // Restart timer
        startTimer();
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

        // Timer toggle: pause/resume (not restart)
        timerToggle.addEventListener('click', () => {
            if (timerInterval) {
                pauseTimer();
            } else if (timerPaused) {
                resumeTimer();
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
