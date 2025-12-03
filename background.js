// ==================== CONSTANTS - Dễ dàng điều chỉnh ====================
const CONFIG = {
    // Delay giữa các lần tìm kiếm (ms)
    SEARCH_DELAY_MIN: 5000,      // 5 giây
    SEARCH_DELAY_MAX: 20000,     // 30 giây
    
    // Scroll settings
    SCROLL_DISTANCE_MIN: 80,     // px mỗi lần scroll
    SCROLL_DISTANCE_MAX: 250,    // px mỗi lần scroll
    SCROLL_DELAY_MIN: 300,       // ms giữa các lần scroll
    SCROLL_DELAY_MAX: 900,       // ms giữa các lần scroll
    SCROLL_START_DELAY_MIN: 500, // ms chờ trước khi bắt đầu scroll
    SCROLL_START_DELAY_MAX: 1500,// ms chờ trước khi bắt đầu scroll
    SCROLL_UP_CHANCE: 0.1,       // 20% cơ hội scroll lên khi chưa đến cuối
    
    // Defaults cho settings
    DEFAULT_TABS_TO_OPEN: 60,
    DEFAULT_DELAY_MODE: 'random',
    DEFAULT_FIXED_DELAY_SECONDS: 10,
};
// ========================================================================

let topics = {};
let isRunning = false;
let stopRequested = false;
let openedTabs = 0;
let totalTabs = 0;

const sleep = ms => new Promise(res => setTimeout(res, ms));

// --- Auto-scroll function to simulate real user behavior ---
function startAutoScroll(tabId) {
    // Truyền config vào injected script
    const scrollConfig = {
        distMin: CONFIG.SCROLL_DISTANCE_MIN,
        distMax: CONFIG.SCROLL_DISTANCE_MAX,
        delayMin: CONFIG.SCROLL_DELAY_MIN,
        delayMax: CONFIG.SCROLL_DELAY_MAX,
        startDelayMin: CONFIG.SCROLL_START_DELAY_MIN,
        startDelayMax: CONFIG.SCROLL_START_DELAY_MAX,
        upChance: CONFIG.SCROLL_UP_CHANCE,
    };
    
    chrome.scripting.executeScript({
        target: { tabId },
        func: (cfg) => {
            if (window._autoScrolling) return;
            window._autoScrolling = true;

            const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
            let reachedBottom = false;

            const doScroll = () => {
                if (!window._autoScrolling || !document.body) return;

                const totalHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
                const maxScroll = totalHeight - window.innerHeight;
                const currentY = window.scrollY;

                let direction;
                if (!reachedBottom) {
                    direction = (currentY > 100 && Math.random() < cfg.upChance) ? -1 : 1;
                    if (currentY >= maxScroll - 10) {
                        reachedBottom = true;
                        direction = -1;
                    }
                } else {
                    direction = -1;
                    if (currentY <= 10) {
                        window._autoScrolling = false;
                        return;
                    }
                }

                let scrollDist = randInt(cfg.distMin, cfg.distMax);
                if (direction === 1) {
                    scrollDist = Math.min(scrollDist, maxScroll - currentY);
                } else {
                    scrollDist = Math.min(scrollDist, currentY);
                }

                window.scrollBy({ top: direction * scrollDist, behavior: 'smooth' });
                setTimeout(doScroll, randInt(cfg.delayMin, cfg.delayMax));
            };

            setTimeout(doScroll, randInt(cfg.startDelayMin, cfg.startDelayMax));
        },
        args: [scrollConfig]
    }).catch(() => {});
}

// --- Helpers to build realistic Bing search URLs with common query parameters ---
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const randHex = (len = 8) => {
    let s = '';
    const hex = '0123456789abcdef';
    for (let i = 0; i < len; i++) s += hex[Math.floor(Math.random() * hex.length)];
    return s;
};

function buildBingUrl(query, opts = {}) {
    // opts can override defaults for testing
    const q = encodeURIComponent(query);
    const qs = opts.qs || 'SS'; // query source (suggestion)
    const pq = opts.pq ? encodeURIComponent(opts.pq) : '';
    const sp = opts.sp || String(randInt(1, 5)); // suggestion position
    const sc = opts.sc || `${randInt(1,30)}-${randInt(1,9)}`; // score-like string
    const sk = opts.sk || randHex(12); // session key / suggestion key
    const cvid = opts.cvid || `${randHex(8)}-${randHex(4)}-${randHex(4)}`; // correlation id
    const refig = opts.refig || randHex(12);
    const FORM = opts.FORM || 'QBRE';
    const pc = opts.pc || 'U531';

    const params = [];
    params.push(`q=${q}`);
    if (pq) params.push(`pq=${pq}`);
    params.push(`qs=${qs}`);
    params.push(`sp=${sp}`);
    params.push(`sc=${sc}`);
    params.push(`sk=${sk}`);
    params.push(`cvid=${cvid}`);
    params.push(`refig=${refig}`);
    params.push(`FORM=${FORM}`);
    params.push(`pc=${pc}`);

    return `https://www.bing.com/search?${params.join('&')}`;
}

async function loadTopics() {
    try {
        const response = await fetch(chrome.runtime.getURL('topics.json'));
        if (!response.ok) throw new Error(`Failed to fetch topics: ${response.statusText}`);
        topics = await response.json();
        console.log("Topics loaded successfully.");
    } catch (error) {
        console.error("Error loading topics:", error);
    }
}

const resetState = () => {
    isRunning = false;
    stopRequested = false;
    openedTabs = 0;
    totalTabs = 0;
    setTimeout(() => {
        chrome.action.setBadgeText({ text: '' });
    }, 2000);
    // broadcast reset status (ignore if no receiver)
    chrome.runtime.sendMessage({ type: 'status', isRunning, openedTabs, totalTabs }).catch(() => {});
};

function sendStatus() {
    chrome.runtime.sendMessage({ type: 'status', isRunning, openedTabs, totalTabs }).catch(() => {});
}

/**
 * Fetches settings from chrome.storage.local with default values.
 * @returns {Promise<object>} A promise that resolves to the settings object.
 */
async function getSettings() {
    const defaults = {
        tabsToOpen: CONFIG.DEFAULT_TABS_TO_OPEN,
        delayMode: CONFIG.DEFAULT_DELAY_MODE,
        fixedDelaySeconds: CONFIG.DEFAULT_FIXED_DELAY_SECONDS,
        customTopics: []
    };
    const settings = await chrome.storage.local.get(defaults);
    return settings;
}

/**
 * Selects and shuffles topics for the search session.
 * @param {object} settings - The extension settings.
 * @param {object} allTopics - The global topics object.
 * @returns {string[]} An array of selected topics.
 */
function selectSearchTopics(settings, allTopics) {
    const { tabsToOpen: numToOpen, customTopics = [] } = settings;
    // Build the topic pool. If custom topics are provided, prefer them.
    const rawPool = (customTopics && customTopics.length) ? customTopics : Object.values(allTopics).flat();

    if (!rawPool || rawPool.length === 0) {
        return [];
    }

    // Ensure unique topics (do not search the same topic twice in one session)
    const uniquePool = Array.from(new Set(rawPool.map(t => t && t.toString().trim()).filter(Boolean)));

    // Shuffle the unique pool and take the required number of topics
    const shuffled = uniquePool.sort(() => 0.5 - Math.random());
    return shuffled.slice(0, numToOpen);
}

/**
 * Executes the sequential search process in a single tab.
 * @param {string[]} selectedTopics - The topics to search for.
 * @param {object} settings - The extension settings.
 */
async function runSearchSession(selectedTopics, settings) {
    const { delayMode, fixedDelaySeconds } = settings;
    const firstTopic = selectedTopics.shift();
    const firstUrl = buildBingUrl(firstTopic);

    // Create a new tab in the current window (do not open a new window)
    const createdTab = await new Promise(resolve => chrome.tabs.create({ url: firstUrl, active: true }, tab => resolve(tab)));
    if (!createdTab) {
        console.error("Could not create a new tab.");
        return;
    }

    const tabId = createdTab.id;
    if (!tabId) {
        console.error("Could not get created tab id.");
        return;
    }

    // Track if tab is still alive
    let tabAlive = true;

    // Listener to trigger auto-scroll when page finishes loading
    const onTabUpdated = (updatedTabId, changeInfo) => {
        if (tabAlive && updatedTabId === tabId && changeInfo.status === 'complete') {
            startAutoScroll(tabId);
        }
    };
    chrome.tabs.onUpdated.addListener(onTabUpdated);

    // Cleanup when tab is closed
    const onTabRemoved = (removedTabId) => {
        if (removedTabId === tabId) {
            tabAlive = false;
            chrome.tabs.onUpdated.removeListener(onTabUpdated);
            chrome.tabs.onRemoved.removeListener(onTabRemoved);
        }
    };
    chrome.tabs.onRemoved.addListener(onTabRemoved);

    openedTabs++;
    await chrome.action.setBadgeText({ text: `${openedTabs}/${totalTabs}` });
    sendStatus();

    let previousTopic = firstTopic;
    const executedTopics = [firstTopic];

    for (const topic of selectedTopics) {
        if (stopRequested || !tabAlive) {
            console.log("Stop requested or tab closed. Halting operation.");
            break;
        }

        // Delay behavior: immediate | fixed | random
        if (delayMode !== 'immediate') {
            const delayMs = (delayMode === 'fixed')
                ? fixedDelaySeconds * 1000
                : randInt(CONFIG.SEARCH_DELAY_MIN, CONFIG.SEARCH_DELAY_MAX);
            await sleep(delayMs);
        }

        if (stopRequested || !tabAlive) {
            console.log("Stop requested or tab closed. Halting operation.");
            break;
        }

        const url = buildBingUrl(topic, { pq: previousTopic });
        const updateSuccess = await new Promise(resolve => {
            chrome.tabs.update(tabId, { url }, () => {
                if (chrome.runtime.lastError) {
                    // Tab no longer exists
                    tabAlive = false;
                    resolve(false);
                    return;
                }
                if (!stopRequested) {
                    openedTabs++;
                    chrome.action.setBadgeText({ text: `${openedTabs}/${totalTabs}` });
                    sendStatus();
                }
                resolve(true);
            });
        });
        
        if (!updateSuccess) break;
        previousTopic = topic;
        executedTopics.push(topic);
    }

    // Cleanup scroll listeners when session ends
    chrome.tabs.onUpdated.removeListener(onTabUpdated);
    chrome.tabs.onRemoved.removeListener(onTabRemoved);

    // Return the list of topics that were actually executed in this session
    return executedTopics;
}

/**
 * Main orchestrator function to start the search process.
 */
const openTabs = async () => {
    if (isRunning) {
        console.log("A session is already running.");
        return;
    }

    try {
        isRunning = true;
        stopRequested = false;
        console.log("Starting search session...");

        const settings = await getSettings();

        // Load persisted seenTopics and runLogs
        const storageData = await chrome.storage.local.get(['seenTopics', 'runLogs']);
        let seenTopics = storageData.seenTopics || {};
        let runLogs = storageData.runLogs || [];

        // Prepare topic pool, excluding topics seen in previous runs
        const { tabsToOpen: numToOpen, customTopics = [] } = settings;
        const rawPool = (customTopics && customTopics.length) ? customTopics : Object.values(topics).flat();
        const uniquePool = Array.from(new Set(rawPool.map(t => t && t.toString().trim()).filter(Boolean)));

        // Filter out topics we've already seen
        let available = uniquePool.filter(t => !(t in seenTopics));

        // If not enough unseen topics remain, clear seenTopics (rotate) and use full pool
        if (available.length < numToOpen) {
            console.log("Not enough unseen topics, clearing seenTopics to rotate pool.");
            seenTopics = {};
            available = uniquePool.slice();
        }

        // Shuffle and pick
        const shuffled = available.sort(() => 0.5 - Math.random());
        const selectedTopics = shuffled.slice(0, numToOpen);

        if (selectedTopics.length === 0) {
            console.error("No topics available to search.");
            return;
        }

        totalTabs = selectedTopics.length;
        openedTabs = 0;
        await chrome.action.setBadgeBackgroundColor({ color: '#0078D4' });
        await chrome.action.setBadgeText({ text: `${openedTabs}/${totalTabs}` });
        sendStatus();

        // Run the session and get the actual executed topics
        const executedTopics = await runSearchSession(selectedTopics, settings) || [];

        console.log("Search session finished. Executed topics:", executedTopics);

        // Persist seenTopics with timestamps for executed topics
        const now = Date.now();
        executedTopics.forEach(t => { if (t) seenTopics[t] = now; });

        // Append run log and trim logs older than 7 days
        runLogs.push({ time: now, count: executedTopics.length, topics: executedTopics });
        const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);
        runLogs = runLogs.filter(entry => (entry.time && entry.time >= sevenDaysAgo));

        // Save updated seenTopics and runLogs
        try {
            await chrome.storage.local.set({ seenTopics, runLogs });
        } catch (e) {
            console.error('Failed to persist seenTopics/runLogs:', e);
        }
    } catch (error) {
        console.error("An error occurred during the search session:", error);
    } finally {
        resetState();
    }
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "startOpeningTabs") {
        openTabs();
        sendResponse({ success: true });
    } else if (request.action === "stopOpeningTabs") {
        stopRequested = true;
        sendResponse({ success: true });
        console.log("Stop request queued.");
    } else if (request.action === "getStatus") {
        sendResponse({ isRunning, openedTabs, totalTabs });
    }
    return true; // Keep message channel open for async response
});
// Note: scheduling/manual time features removed per recent change request.

loadTopics();
console.log("Background script initialized.");