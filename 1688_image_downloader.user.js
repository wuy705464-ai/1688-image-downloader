// ==UserScript==
// @name         1688商品图片批量下载器
// @namespace    1688-product-image-downloader
// @version      0.4.2
// @description  导入1688商品链接，保存主图栏第2至第5张原图链接和商品基本信息；可选同时下载图片
// @author       Mavis
// @homepageURL  https://github.com/wuy705464-ai/1688-image-downloader
// @supportURL   https://github.com/wuy705464-ai/1688-image-downloader/issues
// @downloadURL  https://github.com/wuy705464-ai/1688-image-downloader/raw/refs/heads/main/1688_image_downloader.user.js
// @updateURL    https://github.com/wuy705464-ai/1688-image-downloader/raw/refs/heads/main/1688_image_downloader.user.js
// @match        https://*.1688.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_download
// @grant        GM_addStyle
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    if (document.getElementById('a1688-image-panel')) return;

    const STORAGE_KEY = 'a1688_image_downloader_tasks_v1';
    const RUN_KEY = 'a1688_image_downloader_run_v1';
    const INPUT_KEY = 'a1688_image_downloader_input_v1';
    const SETTINGS_KEY = 'a1688_image_downloader_settings_v1';
    const MAX_IMAGES_PER_PRODUCT = 4;
    const PAGE_WAIT_MS = 2500;
    const TASK_DELAY_MIN_MS = 7000;
    const TASK_DELAY_MAX_MS = 10000;
    const DOWNLOAD_GAP_MS = 650;

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const randomTaskDelay = () => Math.floor(TASK_DELAY_MIN_MS + Math.random() * (TASK_DELAY_MAX_MS - TASK_DELAY_MIN_MS + 1));
    const clean = value => String(value || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    const nowIso = () => new Date().toISOString();
    const errorText = error => clean(error && (error.error || error.message) || error).slice(0, 180);

    function loadJson(key, fallback) {
        try {
            const value = GM_getValue(key, '');
            return value ? JSON.parse(value) : fallback;
        } catch (_) {
            return fallback;
        }
    }

    function saveJson(key, value) {
        GM_setValue(key, JSON.stringify(value));
    }

    function normalizeUrl(value, base = location.href) {
        let text = clean(value).replace(/^['\"]|['\"),;，；]+$/g, '');
        if (!text) return '';
        if (text.startsWith('//')) text = `https:${text}`;
        try {
            const url = new URL(text, base);
            if (!/^https?:$/.test(url.protocol)) return '';
            url.hash = '';
            return url.href;
        } catch (_) {
            return '';
        }
    }

    function canonicalTaskUrl(value) {
        const normalized = normalizeUrl(value);
        if (!normalized) return '';
        try {
            const url = new URL(normalized);
            if (/\.1688\.com$/i.test(url.hostname)) {
                const offer = url.pathname.match(/\/offer\/(\d+)\.html/i);
                if (offer) return `https://detail.1688.com/offer/${offer[1]}.html`;
            }
            return normalized;
        } catch (_) {
            return normalized;
        }
    }

    function isDirectImageUrl(value) {
        try {
            const url = new URL(normalizeUrl(value));
            return /\.(?:jpe?g|png|webp|gif|bmp|avif)(?:$|_)/i.test(url.pathname);
        } catch (_) {
            return false;
        }
    }

    function isVideoUrl(value) {
        try {
            const url = new URL(normalizeUrl(value));
            return /\.(?:mp4|webm|mov|m3u8|flv|avi)(?:$|[?#])/i.test(url.href);
        } catch (_) {
            return false;
        }
    }

    function extractUrls(text) {
        const matches = String(text || '').match(/(?:https?:)?\/\/[^\s<>"']+/gi) || [];
        const seen = new Set();
        const urls = [];
        for (const match of matches) {
            const url = canonicalTaskUrl(match);
            if (!url || seen.has(url) || isVideoUrl(url)) continue;
            seen.add(url);
            urls.push(url);
        }
        return urls;
    }

    function productId(url) {
        const match = String(url || '').match(/\/offer\/(\d+)\.html/i);
        return match ? match[1] : '';
    }

    function taskKey(task) {
        return `${task.type}:${canonicalTaskUrl(task.url)}`;
    }

    function normalizeTask(source) {
        const url = canonicalTaskUrl(source && source.url);
        const type = source && source.type === 'image' || isDirectImageUrl(url) ? 'image' : 'product';
        const allowed = ['pending', 'visiting', 'downloading', 'done', 'error'];
        return {
            url,
            type,
            status: allowed.includes(source && source.status) ? source.status : 'pending',
            offerId: clean(source && source.offerId) || productId(url),
            title: clean(source && source.title),
            price: clean(source && source.price),
            moq: clean(source && source.moq),
            shopName: clean(source && source.shopName),
            images: Array.isArray(source && source.images) ? source.images.map(normalizeImageUrl).filter(Boolean) : [],
            downloaded: Math.max(0, Number(source && source.downloaded) || 0),
            error: clean(source && source.error),
            createdAt: clean(source && source.createdAt) || nowIso(),
            finishedAt: clean(source && source.finishedAt)
        };
    }

    let tasks = (loadJson(STORAGE_KEY, []) || []).map(normalizeTask).filter(item => item.url);
    let run = loadJson(RUN_KEY, { active: false, returnUrl: '', startedAt: '' }) || {};
    let settings = loadJson(SETTINGS_KEY, { outputMode: 'links' }) || {};
    settings.outputMode = settings.outputMode === 'download' ? 'download' : 'links';
    let working = false;
    let ui;

    function saveTasks() {
        saveJson(STORAGE_KEY, tasks);
    }

    function saveRun() {
        saveJson(RUN_KEY, run);
    }

    function saveSettings() {
        const selected = ui?.mode?.querySelector('input[name="a1688-output-mode"]:checked')?.value;
        settings.outputMode = selected === 'download' ? 'download' : 'links';
        saveJson(SETTINGS_KEY, settings);
    }

    function normalizeImageUrl(value) {
        const normalized = normalizeUrl(String(value || '').replace(/&amp;/g, '&'));
        if (!normalized) return '';
        try {
            const url = new URL(normalized);
            url.hash = '';
            // 去掉常见的阿里图片缩放参数，尽量下载原图。
            url.searchParams.delete('x-oss-process');
            url.pathname = url.pathname
                .replace(/\.(jpe?g|png|webp)(?:_[^/?#]+?\.(?:jpe?g|png|webp))$/i, '.$1')
                .replace(/\.(jpe?g|png|webp)_\.webp$/i, '.$1');
            return url.href;
        } catch (_) {
            return normalized;
        }
    }

    function imageFromElement(element) {
        const candidates = [
            element.currentSrc,
            element.getAttribute('src'),
            element.getAttribute('data-src'),
            element.getAttribute('data-lazy-src'),
            element.getAttribute('data-lazyload-src'),
            element.getAttribute('data-original'),
            element.getAttribute('data-ks-lazyload'),
            element.getAttribute('data-img')
        ];
        const background = element.style?.backgroundImage || getComputedStyle(element).backgroundImage || '';
        const backgroundMatch = background.match(/url\(["']?(.+?)["']?\)/i);
        if (backgroundMatch) candidates.push(backgroundMatch[1]);
        const srcset = element.getAttribute('srcset') || element.getAttribute('data-srcset') || '';
        if (srcset) {
            const largest = srcset.split(',').map(part => part.trim().split(/\s+/)[0]).filter(Boolean).pop();
            if (largest) candidates.unshift(largest);
        }
        return candidates.map(value => normalizeImageUrl(value)).find(Boolean) || '';
    }

    function looksLikeProductImage(url) {
        if (!url) return false;
        try {
            const parsed = new URL(url);
            const hostOk = /(?:alicdn\.com|tbcdn\.cn|1688\.com)$/i.test(parsed.hostname);
            const pathOk = /(?:imgextra|img\/ibank|bao\/uploaded|offer|product|pic)/i.test(parsed.pathname);
            const junk = /(?:avatar|logo|icon|sprite|qrcode|qr-code|loading|placeholder|blank)/i.test(parsed.href);
            return hostOk && pathOk && !junk;
        } catch (_) {
            return false;
        }
    }

    function isVideoThumbnail(element, url) {
        if (!element) return false;
        if (element.closest([
            'video',
            '[class*="video"]',
            '[class*="Video"]',
            '[data-type="video"]',
            '[data-media-type="video"]',
            '[aria-label*="视频"]',
            '[title*="视频"]'
        ].join(','))) return true;

        const item = element.closest('li, [class*="thumb"], [class*="item"]');
        if (item && item.querySelector('video, [class*="play-icon"], [class*="playIcon"], [class*="video-icon"], [class*="videoIcon"]')) return true;

        return /(?:\/video\/|video[-_]?cover|video[-_]?poster|video[-_]?snapshot)/i.test(url || '');
    }

    function collectFromSelectors(selectors, output, seen) {
        for (const selector of selectors) {
            for (const image of document.querySelectorAll(selector)) {
                const url = imageFromElement(image);
                if (!url || seen.has(url) || !looksLikeProductImage(url) || isVideoThumbnail(image, url)) continue;
                seen.add(url);
                output.push(url);
            }
        }
    }

    function extractProductImages() {
        const ordered = [];
        const seen = new Set();

        // 优先只读左侧主图缩略图栏，不混入商品详情长图、SKU 图和推荐商品图。
        collectFromSelectors([
            '[class*="thumbnail"] img',
            '[class*="thumbnail"] [style*="background-image"]',
            '[class*="thumb-list"] img',
            '[class*="thumbList"] img',
            '[class*="thumb"] img',
            '[class*="image-list"] img',
            '[class*="imageList"] img'
        ], ordered, seen);

        // 页面类名变化时，退回到商品画廊容器。
        if (ordered.length < 2) collectFromSelectors([
            '[class*="gallery"] img',
            '[class*="main-image"] img',
            '[class*="mainImage"] img',
            '[class*="offer-img"] img',
            '[class*="preview"] img'
        ], ordered, seen);

        // 最后按截图中的位置特征兜底：页面左上商品画廊区域内的图片。
        if (ordered.length < 2) for (const image of document.images) {
            const url = imageFromElement(image);
            if (!url || seen.has(url) || !looksLikeProductImage(url) || isVideoThumbnail(image, url)) continue;
            const rect = image.getBoundingClientRect();
            if (rect.bottom < 0 || rect.top > Math.max(950, innerHeight * 1.15)) continue;
            if (rect.left > innerWidth * 0.62 || rect.width < 38 || rect.height < 38) continue;
            seen.add(url);
            ordered.push(url);
        }

        // 第一张是商品首图：明确排除，再取最多四张。
        return ordered.slice(1, 1 + MAX_IMAGES_PER_PRODUCT);
    }

    function firstUsefulText(selectors, predicate = () => true) {
        for (const selector of selectors) {
            for (const element of document.querySelectorAll(selector)) {
                const value = clean(element.getAttribute('content') || element.textContent);
                if (value && value.length <= 120 && predicate(value)) return value;
            }
        }
        return '';
    }

    function jsonStringValue(keys) {
        const scripts = [...document.scripts].map(script => script.textContent || '').filter(Boolean);
        for (const key of keys) {
            const pattern = new RegExp(`"${key}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`, 'i');
            for (const script of scripts) {
                const match = script.match(pattern);
                if (!match) continue;
                try {
                    const value = clean(JSON.parse(match[1]));
                    if (value && value.length <= 120) return value;
                } catch (_) { /* 尝试下一个来源 */ }
            }
        }
        return '';
    }

    function extractBasicInfo() {
        const title = firstUsefulText([
            'h1',
            'meta[property="og:title"]',
            'meta[name="keywords"]'
        ]) || jsonStringValue(['subject', 'title', 'offerTitle']);

        const price = firstUsefulText([
            'meta[property="product:price:amount"]',
            '[class*="price-range"]',
            '[class*="priceRange"]',
            '[class*="price-text"]',
            '[class*="priceText"]',
            '[class~="price"]'
        ], value => /(?:[¥￥]\s*)?\d+(?:\.\d+)?/.test(value)) || jsonStringValue(['price', 'priceText', 'priceRange']);

        let moq = firstUsefulText([
            '[class*="start-amount"]',
            '[class*="begin-amount"]',
            '[class*="moq"]',
            '[class*="min-order"]'
        ], value => /(?:起批|起订|MOQ|件|个|套|盒|包)/i.test(value));
        if (!moq) {
            const bodyMatch = (document.body?.innerText || '').match(/(?:起批量|最小起订量|起订量|MOQ)\s*[:：]?\s*([^\n]{1,45})/i);
            moq = clean(bodyMatch && bodyMatch[1]);
        }

        const shopName = firstUsefulText([
            '[class*="company-name"]',
            '[class*="companyName"]',
            '[class*="shop-name"]',
            '[class*="shopName"]',
            '[class*="supplier-name"]',
            '[class*="seller-name"]'
        ], value => !/(?:收藏|关注|联系|客服|进入店铺)/.test(value)) || jsonStringValue([
            'companyName', 'sellerCompanyName', 'shopName', 'supplierName'
        ]);

        return {
            offerId: productId(location.href),
            title,
            price,
            moq,
            shopName
        };
    }

    function fileExtension(url) {
        try {
            const match = new URL(url).pathname.match(/\.(jpe?g|png|webp|gif|bmp|avif)(?:$|_)/i);
            return match ? (match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase()) : 'jpg';
        } catch (_) {
            return 'jpg';
        }
    }

    function safePart(value, fallback) {
        const result = clean(value)
            .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
            .replace(/[. ]+$/g, '')
            .slice(0, 55);
        return result || fallback;
    }

    function downloadName(task, imageUrl, index) {
        const id = task.offerId || productId(task.url) || '直接图片';
        const title = safePart(task.title, '商品');
        const imageNumber = task.type === 'product' ? index + 2 : index + 1;
        const ext = fileExtension(imageUrl);
        return `1688_${id}_${title}_图${imageNumber}.${ext}`;
    }

    function csvCell(value) {
        return `"${String(value ?? '').replace(/"/g, '""')}"`;
    }

    function exportCsv() {
        if (!tasks.length) {
            setStatus('当前没有可导出的记录。', 'error');
            return;
        }
        const header = ['商品ID', '商品标题', '价格', '起订量', '店铺或公司', '商品链接', '状态', '已下载图片数', '图片2', '图片3', '图片4', '图片5', '错误'];
        const rows = tasks.map(task => [
            task.offerId || productId(task.url),
            task.title,
            task.price,
            task.moq,
            task.shopName,
            task.url,
            task.status,
            task.downloaded,
            ...(task.type === 'product' ? task.images.slice(0, 4) : [task.images[0] || task.url]),
            task.error
        ]);
        while (rows.some(row => row.length < header.length)) {
            for (const row of rows) if (row.length < header.length) row.splice(row.length - 1, 0, '');
        }
        const csv = '\uFEFF' + [header, ...rows].map(row => row.slice(0, header.length).map(csvCell).join(',')).join('\r\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `1688商品图片_${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        setStatus(`已导出 ${tasks.length} 条商品记录。`, 'success');
    }

    function gmDownload(url, name) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = fn => value => {
                if (settled) return;
                settled = true;
                fn(value);
            };
            const ok = finish(resolve);
            const fail = finish(value => reject(new Error(errorText(value) || '下载失败')));
            try {
                GM_download({
                    url,
                    name,
                    saveAs: false,
                    conflictAction: 'uniquify',
                    onload: ok,
                    onerror: fail,
                    ontimeout: () => fail(new Error('下载超时'))
                });
                setTimeout(() => fail(new Error('下载等待超时')), 45000);
            } catch (error) {
                fail(error);
            }
        });
    }

    function isVerificationPage() {
        if (/(?:punish|captcha|verify|sec-check)/i.test(location.href)) return true;
        return !!document.querySelector('[class*="captcha"], #nc_1_wrapper, .nc-container, iframe[src*="captcha"], iframe[src*="verify"]');
    }

    async function autoScrollForImages() {
        const originalY = window.scrollY;
        const steps = 7;
        for (let i = 1; i <= steps; i++) {
            if (!run.active) return;
            const maxY = Math.max(0, document.documentElement.scrollHeight - innerHeight);
            window.scrollTo({ top: Math.round(maxY * i / steps), behavior: 'auto' });
            await sleep(450);
        }
        window.scrollTo({ top: originalY, behavior: 'auto' });
        await sleep(300);
    }

    function currentPendingTask() {
        return tasks.find(item => ['pending', 'visiting', 'downloading'].includes(item.status));
    }

    async function waitBeforeNextTask() {
        if (!run.active || !currentPendingTask()) return;
        let remaining = randomTaskDelay();
        while (remaining > 0 && run.active) {
            setStatus(`本条已完成，${Math.ceil(remaining / 1000)} 秒后处理下一条…`, 'success');
            const step = Math.min(1000, remaining);
            await sleep(step);
            remaining -= step;
        }
    }

    function currentPageMatches(task) {
        if (!task || task.type !== 'product') return false;
        const taskId = productId(task.url);
        const pageId = productId(location.href);
        return taskId ? taskId === pageId : canonicalTaskUrl(task.url) === canonicalTaskUrl(location.href);
    }

    async function saveTaskImages(task, images) {
        task.status = 'downloading';
        task.images = images;
        task.downloaded = 0;
        task.error = '';
        saveTasks();
        render();

        if (settings.outputMode === 'links') {
            setStatus(`正在保存 ${task.title || productId(task.url) || '商品'} 的图片链接…`);
            return;
        }

        for (let i = 0; i < images.length; i++) {
            if (!run.active) throw new Error('用户已暂停');
            setStatus(`正在下载 ${task.title || productId(task.url) || '图片'}：${i + 1}/${images.length}`);
            await gmDownload(images[i], downloadName(task, images[i], i));
            task.downloaded = i + 1;
            saveTasks();
            render();
            if (i < images.length - 1) await sleep(DOWNLOAD_GAP_MS);
        }
    }

    async function processProductPage(task) {
        if (working) return;
        working = true;
        let continueQueue = false;
        try {
            if (isVerificationPage()) {
                run.active = false;
                saveRun();
                task.status = 'pending';
                task.error = '遇到安全验证，完成验证后点击继续';
                saveTasks();
                setStatus('检测到安全验证。请手动完成后点击“继续”。', 'error');
                return;
            }

            setStatus('正在加载商品图片…');
            await sleep(PAGE_WAIT_MS);
            const images = extractProductImages();
            Object.assign(task, extractBasicInfo());
            task.title ||= clean(document.title.replace(/[-_|].*$/, ''));
            if (!images.length) throw new Error('未找到可下载图片；请把这个商品链接发给我适配');

            await saveTaskImages(task, images);
            task.status = 'done';
            task.finishedAt = nowIso();
            task.error = '';
            saveTasks();
            setStatus(settings.outputMode === 'download'
                ? `本商品完成：已跳过首图，保存链接并下载 ${images.length} 张。`
                : `本商品完成：已保存主图栏第2～${images.length + 1}张的链接。`, 'success');
            continueQueue = true;
        } catch (error) {
            if (errorText(error) === '用户已暂停') {
                task.status = 'pending';
                task.error = '';
            } else {
                task.status = 'error';
                task.error = errorText(error);
            }
            saveTasks();
            render();
            continueQueue = run.active;
        } finally {
            working = false;
        }
        if (continueQueue && run.active) {
            await waitBeforeNextTask();
            await processNext();
        }
    }

    async function processDirectImage(task) {
        if (working) return;
        working = true;
        try {
            task.title = task.title || '直接图片';
            await saveTaskImages(task, [normalizeImageUrl(task.url)]);
            task.status = 'done';
            task.finishedAt = nowIso();
            saveTasks();
        } catch (error) {
            task.status = errorText(error) === '用户已暂停' ? 'pending' : 'error';
            task.error = task.status === 'error' ? errorText(error) : '';
            saveTasks();
        } finally {
            working = false;
        }
        render();
        if (run.active) {
            await waitBeforeNextTask();
            await processNext();
        }
    }

    async function processNext() {
        if (!run.active || working) return;
        let task = currentPendingTask();
        if (!task) {
            run.active = false;
            saveRun();
            render();
            const failed = tasks.filter(item => item.status === 'error').length;
            setStatus(failed ? `待办已处理完，另有 ${failed} 条失败记录可重试。` : '全部完成。', failed ? 'error' : 'success');
            if (run.returnUrl && canonicalTaskUrl(run.returnUrl) !== canonicalTaskUrl(location.href)) {
                await sleep(1200);
                location.href = run.returnUrl;
            }
            return;
        }

        if (task.status === 'error') return;
        if (task.type === 'image') {
            await processDirectImage(task);
            return;
        }

        if (currentPageMatches(task)) {
            task.status = 'visiting';
            saveTasks();
            render();
            await processProductPage(task);
            return;
        }

        task.status = 'visiting';
        task.error = '';
        saveTasks();
        render();
        setStatus(`正在进入商品页：${productId(task.url) || task.url}`);
        location.href = task.url;
    }

    function addUrls(text) {
        const urls = extractUrls(text);
        const keys = new Set(tasks.map(taskKey));
        let added = 0;
        for (const url of urls) {
            const task = normalizeTask({ url, type: isDirectImageUrl(url) ? 'image' : 'product' });
            const key = taskKey(task);
            if (keys.has(key)) continue;
            keys.add(key);
            tasks.push(task);
            added++;
        }
        saveTasks();
        render();
        setStatus(urls.length ? `识别 ${urls.length} 条链接，新增 ${added} 条。` : '没有识别到有效链接。', urls.length ? 'success' : 'error');
        return added;
    }

    function startRun() {
        addUrls(ui.input.value);
        for (const task of tasks) {
            if (task.status === 'visiting' || task.status === 'downloading') task.status = 'pending';
        }
        const unfinished = tasks.some(task => task.status === 'pending');
        if (!unfinished) {
            setStatus(tasks.length ? '没有待处理任务。可点击失败数量后重试，或清空后重新导入。' : '请先粘贴或导入链接。', 'error');
            return;
        }
        run = {
            active: true,
            returnUrl: run.returnUrl || location.href,
            startedAt: run.startedAt || nowIso()
        };
        saveTasks();
        saveRun();
        render();
        processNext();
    }

    function pauseRun() {
        run.active = false;
        saveRun();
        const active = tasks.find(task => ['visiting', 'downloading'].includes(task.status));
        if (active) active.status = 'pending';
        saveTasks();
        render();
        setStatus('已暂停，进度已经保存。');
    }

    function retryErrors() {
        let count = 0;
        for (const task of tasks) {
            if (task.status !== 'error') continue;
            task.status = 'pending';
            task.error = '';
            task.downloaded = 0;
            count++;
        }
        saveTasks();
        render();
        setStatus(count ? `已将 ${count} 条失败任务放回队列。` : '当前没有失败任务。', count ? 'success' : '');
    }

    function clearFinished() {
        if (!confirm('确定清除已经完成的记录吗？清除后，这些尚未导出的图片链接也会被删除。')) return;
        tasks = tasks.filter(task => task.status !== 'done');
        saveTasks();
        render();
        setStatus('已清除完成记录。');
    }

    function setStatus(text, type = '') {
        if (!ui) return;
        ui.status.textContent = text;
        ui.status.className = `a1688-status ${type}`;
    }

    function render() {
        if (!ui) return;
        const counts = { all: tasks.length, done: 0, pending: 0, error: 0 };
        for (const task of tasks) {
            if (task.status === 'done') counts.done++;
            else if (task.status === 'error') counts.error++;
            else counts.pending++;
        }
        ui.counts.innerHTML = `共 <b>${counts.all}</b> 条 · 待处理 <b>${counts.pending}</b> · 完成 <b>${counts.done}</b> · 失败 <button type="button" id="a1688-retry-count">${counts.error}</button>`;
        ui.start.textContent = run.active ? '运行中…' : (counts.done || counts.pending ? '开始 / 继续' : '开始采集');
        ui.start.disabled = !!run.active;
        ui.pause.disabled = !run.active;
        ui.rule.textContent = `只取左侧主图栏静态图片：排除视频，跳过第1张图片，保存第2～5张链接；任务间隔7–10秒。`;
        document.getElementById('a1688-retry-count')?.addEventListener('click', retryErrors);
    }

    function createPanel() {
        const panel = document.createElement('section');
        panel.id = 'a1688-image-panel';
        panel.innerHTML = `
            <div class="a1688-head">
                <strong>🖼️ 1688 商品图片采集</strong>
                <button type="button" id="a1688-fold">收起</button>
            </div>
            <div id="a1688-body">
                <div class="a1688-tip" id="a1688-rule"></div>
                <textarea id="a1688-input" rows="6" placeholder="一行一个链接：\nhttps://detail.1688.com/offer/123456789.html\nhttps://cbu01.alicdn.com/img/ibank/xxx.jpg"></textarea>
                <div class="a1688-row">
                    <button type="button" id="a1688-import">导入 TXT / CSV</button>
                    <button type="button" id="a1688-current">添加当前商品页</button>
                    <input type="file" id="a1688-file" accept=".txt,.csv,text/plain,text/csv" hidden>
                </div>
                <div class="a1688-mode" id="a1688-mode">
                    <span>保存方式</span>
                    <label><input type="radio" name="a1688-output-mode" value="links"> 只保存链接</label>
                    <label><input type="radio" name="a1688-output-mode" value="download"> 链接＋图片</label>
                </div>
                <div class="a1688-counts" id="a1688-counts"></div>
                <div class="a1688-row">
                    <button type="button" class="primary" id="a1688-start">开始采集</button>
                    <button type="button" id="a1688-pause">暂停</button>
                    <button type="button" id="a1688-export">导出商品表</button>
                    <button type="button" id="a1688-clear">清空完成记录</button>
                </div>
                <div class="a1688-status" id="a1688-status">等待导入链接。</div>
            </div>`;
        document.documentElement.appendChild(panel);

        ui = {
            panel,
            body: panel.querySelector('#a1688-body'),
            input: panel.querySelector('#a1688-input'),
            file: panel.querySelector('#a1688-file'),
            mode: panel.querySelector('#a1688-mode'),
            start: panel.querySelector('#a1688-start'),
            pause: panel.querySelector('#a1688-pause'),
            counts: panel.querySelector('#a1688-counts'),
            status: panel.querySelector('#a1688-status'),
            rule: panel.querySelector('#a1688-rule')
        };

        ui.input.value = GM_getValue(INPUT_KEY, '');
        const currentMode = ui.mode.querySelector(`input[value="${settings.outputMode}"]`);
        if (currentMode) currentMode.checked = true;
        ui.mode.addEventListener('change', event => {
            if (!event.target.matches('input[name="a1688-output-mode"]')) return;
            saveSettings();
            render();
            setStatus(settings.outputMode === 'download' ? '将保存链接并下载图片。' : '将只保存图片链接，不下载图片。');
        });
        ui.input.addEventListener('input', () => GM_setValue(INPUT_KEY, ui.input.value));
        ui.input.addEventListener('dragover', event => event.preventDefault());
        ui.input.addEventListener('drop', async event => {
            event.preventDefault();
            const file = event.dataTransfer?.files?.[0];
            if (file) {
                ui.input.value = await file.text();
                GM_setValue(INPUT_KEY, ui.input.value);
                addUrls(ui.input.value);
            }
        });
        panel.querySelector('#a1688-import').addEventListener('click', () => ui.file.click());
        ui.file.addEventListener('change', async () => {
            const file = ui.file.files?.[0];
            if (!file) return;
            ui.input.value = await file.text();
            GM_setValue(INPUT_KEY, ui.input.value);
            addUrls(ui.input.value);
            ui.file.value = '';
        });
        panel.querySelector('#a1688-current').addEventListener('click', () => {
            ui.input.value = `${ui.input.value.trim()}\n${location.href}`.trim();
            GM_setValue(INPUT_KEY, ui.input.value);
            addUrls(location.href);
        });
        ui.start.addEventListener('click', startRun);
        ui.pause.addEventListener('click', pauseRun);
        panel.querySelector('#a1688-export').addEventListener('click', exportCsv);
        panel.querySelector('#a1688-clear').addEventListener('click', clearFinished);
        panel.querySelector('#a1688-fold').addEventListener('click', event => {
            const hidden = ui.body.hidden = !ui.body.hidden;
            event.currentTarget.textContent = hidden ? '展开' : '收起';
        });
        render();
    }

    GM_addStyle(`
        #a1688-image-panel { position: fixed; right: 22px; top: 88px; z-index: 2147483647; width: 370px;
            box-sizing: border-box; color: #213547; background: rgba(255,255,255,.98); border: 2px solid #ff6000;
            border-radius: 12px; box-shadow: 0 10px 30px rgba(40,52,70,.18); font: 14px/1.5 Arial,"Microsoft YaHei",sans-serif; }
        #a1688-image-panel * { box-sizing: border-box; }
        .a1688-head { display:flex; align-items:center; justify-content:space-between; padding:12px 14px; color:#7a2d00;
            background:linear-gradient(135deg,#fff7f0,#fff); border-radius:10px 10px 0 0; }
        .a1688-head strong { font-size:16px; }
        #a1688-body { padding:0 14px 14px; }
        #a1688-image-panel textarea { width:100%; resize:vertical; padding:9px 10px; border:1px solid #ffd0b3; border-radius:8px;
            outline:none; color:#2e3540; background:#fffdfa; font:12px/1.55 Consolas,monospace; }
        #a1688-image-panel textarea:focus { border-color:#ff6000; box-shadow:0 0 0 3px rgba(255,96,0,.10); }
        .a1688-mode { display:flex; align-items:center; flex-wrap:wrap; gap:7px; margin-top:9px; color:#5c514a; }
        .a1688-mode > span { margin-right:2px; }
        .a1688-mode label { display:flex; align-items:center; gap:3px; padding:5px 8px; border:1px solid #ffd0b3; border-radius:6px; background:#fffaf6; cursor:pointer; }
        .a1688-mode input { margin:0; accent-color:#ff6000; }
        .a1688-tip { margin:0 0 8px; color:#6d5d52; font-size:12px; }
        .a1688-row { display:flex; flex-wrap:wrap; gap:7px; margin-top:9px; }
        #a1688-image-panel button { padding:6px 10px; border:1px solid #ff7a29; border-radius:6px; color:#d74d00; background:#fff;
            cursor:pointer; font:inherit; }
        #a1688-image-panel button:hover { background:#fff3eb; }
        #a1688-image-panel button.primary { color:#fff; background:#ff6000; border-color:#ff6000; }
        #a1688-image-panel button:disabled { opacity:.48; cursor:not-allowed; }
        .a1688-counts { margin-top:10px; color:#4d5664; }
        .a1688-counts b { color:#ed5b00; }
        .a1688-counts button { padding:0 4px !important; border:0 !important; color:#d93025 !important; background:transparent !important; font-weight:bold !important; }
        .a1688-status { margin-top:10px; padding:8px 9px; border-radius:6px; color:#59636f; background:#f4f6f8; font-size:12px; white-space:pre-wrap; }
        .a1688-status.success { color:#087c4c; background:#eaf9f1; }
        .a1688-status.error { color:#c5221f; background:#fff0ef; }
    `);

    createPanel();

    // 页面跳转后自动续跑。
    if (run.active) {
        const task = currentPendingTask();
        if (task && task.type === 'product' && currentPageMatches(task)) {
            setStatus('已进入商品页，准备提取图片…');
            setTimeout(() => processProductPage(task), 500);
        } else {
            setTimeout(processNext, 500);
        }
    }
})();
