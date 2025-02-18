/*!
 * puppeteer-extra-plugin-recaptcha v3.3.7 by berstend
 * https://github.com/berstend/puppeteer-extra/tree/master/packages/puppeteer-extra-plugin-recaptcha
 * @license MIT
 */
import { PuppeteerExtraPlugin } from 'puppeteer-extra-plugin';
import Debug from 'debug';

const ContentScriptDefaultOpts = {
    visualFeedback: true,
    debugBinding: undefined
};
const ContentScriptDefaultData = {
    solutions: []
};
/**
 * Content script for Recaptcha handling (runs in browser context)
 * @note External modules are not supported here (due to content script isolation)
 */
class RecaptchaContentScript {
    constructor(opts = ContentScriptDefaultOpts, data = ContentScriptDefaultData) {
        /** Log using debug binding if available */
        this.log = (message, data) => {
            if (this.opts.debugBinding && window.top[this.opts.debugBinding]) {
                window.top[this.opts.debugBinding](message, JSON.stringify(data));
            }
        };
        // Poor mans _.pluck
        this._pick = (props) => (o) => props.reduce((a, e) => (Object.assign(Object.assign({}, a), { [e]: o[e] })), {});
        // make sure the element is visible - this is equivalent to jquery's is(':visible')
        this._isVisible = (elem) => !!(elem.offsetWidth ||
            elem.offsetHeight ||
            (typeof elem.getClientRects === 'function' &&
                elem.getClientRects().length));
        this.opts = opts;
        this.data = data;
        this.frameSources = this._generateFrameSources();
        this.log('Intialized', { url: document.location.href, opts: this.opts });
    }
    /** Check if an element is in the current viewport */
    _isInViewport(elem) {
        const rect = elem.getBoundingClientRect();
        return (rect.top >= 0 &&
            rect.left >= 0 &&
            rect.bottom <=
                (window.innerHeight ||
                    (document.documentElement.clientHeight &&
                        rect.right <=
                            (window.innerWidth || document.documentElement.clientWidth))));
    }
    // Recaptcha client is a nested, circular object with object keys that seem generated
    // We flatten that object a couple of levels deep for easy access to certain keys we're interested in.
    _flattenObject(item, levels = 2, ignoreHTML = true) {
        const isObject = (x) => x && typeof x === 'object';
        const isHTML = (x) => x && x instanceof HTMLElement;
        let newObj = {};
        for (let i = 0; i < levels; i++) {
            item = Object.keys(newObj).length ? newObj : item;
            Object.keys(item).forEach(key => {
                if (ignoreHTML && isHTML(item[key]))
                    return;
                if (isObject(item[key])) {
                    Object.keys(item[key]).forEach(innerKey => {
                        if (ignoreHTML && isHTML(item[key][innerKey]))
                            return;
                        const keyName = isObject(item[key][innerKey])
                            ? `obj_${key}_${innerKey}`
                            : `${innerKey}`;
                        newObj[keyName] = item[key][innerKey];
                    });
                }
                else {
                    newObj[key] = item[key];
                }
            });
        }
        return newObj;
    }
    // Helper function to return an object based on a well known value
    _getKeyByValue(object, value) {
        return Object.keys(object).find(key => object[key] === value);
    }
    async _waitUntilDocumentReady() {
        return new Promise(function (resolve) {
            if (!document || !window) {
                return resolve(null);
            }
            const loadedAlready = /^loaded|^i|^c/.test(document.readyState);
            if (loadedAlready) {
                return resolve(null);
            }
            function onReady() {
                resolve(null);
                document.removeEventListener('DOMContentLoaded', onReady);
                window.removeEventListener('load', onReady);
            }
            document.addEventListener('DOMContentLoaded', onReady);
            window.addEventListener('load', onReady);
        });
    }
    _paintCaptchaBusy($iframe) {
        try {
            if (this.opts.visualFeedback) {
                $iframe.style.filter = `opacity(60%) hue-rotate(400deg)`; // violet
            }
        }
        catch (error) {
            // noop
        }
        return $iframe;
    }
    _paintCaptchaSolved($iframe) {
        try {
            if (this.opts.visualFeedback) {
                $iframe.style.filter = `opacity(60%) hue-rotate(230deg)`; // green
            }
        }
        catch (error) {
            // noop
        }
        return $iframe;
    }
    _findVisibleIframeNodes() {
        return Array.from(document.querySelectorAll(this.getFrameSelectorForId('anchor', '') // intentionally blank
        ));
    }
    _findVisibleIframeNodeById(id) {
        return document.querySelector(this.getFrameSelectorForId('anchor', id));
    }
    _hideChallengeWindowIfPresent(id = '') {
        let frame = document.querySelector(this.getFrameSelectorForId('bframe', id));
        this.log(' - _hideChallengeWindowIfPresent', { id, hasFrame: !!frame });
        if (!frame) {
            return;
        }
        while (frame &&
            frame.parentElement &&
            frame.parentElement !== document.body) {
            frame = frame.parentElement;
        }
        if (frame) {
            frame.style.visibility = 'hidden';
        }
    }
    // There's so many different possible deployments URLs that we better generate them
    _generateFrameSources() {
        const protos = ['http', 'https'];
        const hosts = [
            'google.com',
            'www.google.com',
            'recaptcha.net',
            'www.recaptcha.net'
        ];
        // @ts-ignore
        const origins = protos.flatMap(proto => hosts.map(host => `${proto}://${host}`));
        const paths = {
            anchor: ['/recaptcha/api2/anchor', '/recaptcha/enterprise/anchor'],
            bframe: ['/recaptcha/api2/bframe', '/recaptcha/enterprise/bframe']
        };
        return {
            anchor: origins.flatMap(origin => paths.anchor.map(path => `${origin}${path}`)),
            bframe: origins.flatMap(origin => paths.bframe.map(path => `${origin}${path}`))
        };
    }
    getFrameSelectorForId(type = 'anchor', id = '') {
        const namePrefix = type === 'anchor' ? 'a' : 'c';
        return this.frameSources[type]
            .map(src => `iframe[src^='${src}'][name^="${namePrefix}-${id}"]`)
            .join(',');
    }
    getClients() {
        // Bail out early if there's no indication of recaptchas
        if (!window || !window.__google_recaptcha_client)
            return;
        if (!window.___grecaptcha_cfg || !window.___grecaptcha_cfg.clients) {
            return;
        }
        if (!Object.keys(window.___grecaptcha_cfg.clients).length)
            return;
        return window.___grecaptcha_cfg.clients;
    }
    getVisibleIframesIds() {
        // Find all regular visible recaptcha boxes through their iframes
        const result = this._findVisibleIframeNodes()
            .filter($f => this._isVisible($f))
            .map($f => this._paintCaptchaBusy($f))
            .filter($f => $f && $f.getAttribute('name'))
            .map($f => $f.getAttribute('name') || '') // a-841543e13666
            .map(rawId => rawId.split('-').slice(-1)[0] // a-841543e13666 => 841543e13666
        )
            .filter(id => id);
        this.log('getVisibleIframesIds', result);
        return result;
    }
    // TODO: Obsolete with recent changes
    getInvisibleIframesIds() {
        // Find all invisible recaptcha boxes through their iframes (only the ones with an active challenge window)
        const result = this._findVisibleIframeNodes()
            .filter($f => $f && $f.getAttribute('name'))
            .map($f => $f.getAttribute('name') || '') // a-841543e13666
            .map(rawId => rawId.split('-').slice(-1)[0] // a-841543e13666 => 841543e13666
        )
            .filter(id => id)
            .filter(id => document.querySelectorAll(this.getFrameSelectorForId('bframe', id))
            .length);
        this.log('getInvisibleIframesIds', result);
        return result;
    }
    getIframesIds() {
        // Find all recaptcha boxes through their iframes, check for invisible ones as fallback
        const results = [
            ...this.getVisibleIframesIds(),
            ...this.getInvisibleIframesIds()
        ];
        this.log('getIframesIds', results);
        // Deduplicate results by using the unique id as key
        const dedup = Array.from(new Set(results));
        this.log('getIframesIds - dedup', dedup);
        return dedup;
    }
    isEnterpriseCaptcha(id) {
        if (!id)
            return false;
        // The only way to determine if a captcha is an enterprise one is by looking at their iframes
        const prefix = 'iframe[src*="/recaptcha/"][src*="/enterprise/"]';
        const nameSelectors = [`[name^="a-${id}"]`, `[name^="c-${id}"]`];
        const fullSelector = nameSelectors.map(name => prefix + name).join(',');
        return document.querySelectorAll(fullSelector).length > 0;
    }
    isInvisible(id) {
        if (!id)
            return false;
        const selector = `iframe[src*="/recaptcha/"][src*="/anchor"][name="a-${id}"][src*="&size=invisible"]`;
        return document.querySelectorAll(selector).length > 0;
    }
    /** Whether an active challenge popup is open */
    hasActiveChallengePopup(id) {
        if (!id)
            return false;
        const selector = `iframe[src*="/recaptcha/"][src*="/bframe"][name="c-${id}"]`;
        const elem = document.querySelector(selector);
        if (!elem) {
            return false;
        }
        return this._isInViewport(elem); // note: _isVisible doesn't work here as the outer div is hidden, not the iframe itself
    }
    /** Whether an (invisible) captcha has a challenge bframe - otherwise it's a score based captcha */
    hasChallengeFrame(id) {
        if (!id)
            return false;
        return (document.querySelectorAll(this.getFrameSelectorForId('bframe', id))
            .length > 0);
    }
    isInViewport(id) {
        if (!id)
            return;
        const prefix = 'iframe[src*="recaptcha"]';
        const nameSelectors = [`[name^="a-${id}"]`, `[name^="c-${id}"]`];
        const fullSelector = nameSelectors.map(name => prefix + name).join(',');
        const elem = document.querySelector(fullSelector);
        if (!elem) {
            return false;
        }
        return this._isInViewport(elem);
    }
    getResponseInputById(id) {
        if (!id)
            return;
        const $iframe = this._findVisibleIframeNodeById(id);
        if (!$iframe)
            return;
        const $parentForm = $iframe.closest(`form`);
        if ($parentForm) {
            return $parentForm.querySelector(`[name='g-recaptcha-response']`);
        }
        // Not all reCAPTCHAs are in forms
        // https://github.com/berstend/puppeteer-extra/issues/57
        if (document && document.body) {
            return document.body.querySelector(`[name='g-recaptcha-response']`);
        }
    }
    getClientById(id) {
        if (!id)
            return;
        const clients = this.getClients();
        // Lookup captcha "client" info using extracted id
        let client = Object.values(clients || {})
            .filter(obj => this._getKeyByValue(obj, id))
            .shift(); // returns first entry in array or undefined
        this.log(' - getClientById:client', { id, hasClient: !!client });
        if (!client)
            return;
        client = this._flattenObject(client);
        client.widgetId = client.id;
        client.id = id;
        this.log(' - getClientById:client:flatten', {
            id,
            hasClient: !!client
        });
        return client;
    }
    extractInfoFromClient(client) {
        if (!client)
            return;
        const info = this._pick(['sitekey', 'callback'])(client);
        if (!info.sitekey)
            return;
        info._vendor = 'recaptcha';
        info.id = client.id;
        info.s = client.s; // google site specific
        info.widgetId = client.widgetId;
        info.display = this._pick([
            'size',
            'top',
            'left',
            'width',
            'height',
            'theme'
        ])(client);
        if (client && client.action) {
            info.action = client.action;
        }
        // callbacks can be strings or funtion refs
        if (info.callback && typeof info.callback === 'function') {
            info.callback = info.callback.name || 'anonymous';
        }
        if (document && document.location)
            info.url = document.location.href;
        return info;
    }
    async findRecaptchas() {
        const result = {
            captchas: [],
            error: null
        };
        try {
            await this._waitUntilDocumentReady();
            const clients = this.getClients();
            this.log('findRecaptchas', {
                url: document.location.href,
                hasClients: !!clients
            });
            if (!clients)
                return result;
            result.captchas = this.getIframesIds()
                .map(id => this.getClientById(id))
                .map(client => this.extractInfoFromClient(client))
                .map(info => {
                this.log(' - captchas:info', info);
                if (!info)
                    return;
                const $input = this.getResponseInputById(info.id);
                info.hasResponseElement = !!$input;
                return info;
            })
                .filter(info => !!info && !!info.sitekey)
                .map(info => {
                info.sitekey = info.sitekey.trim();
                info.isEnterprise = this.isEnterpriseCaptcha(info.id);
                info.isInViewport = this.isInViewport(info.id);
                info.isInvisible = this.isInvisible(info.id);
                info._type = 'checkbox';
                if (info.isInvisible) {
                    info._type = 'invisible';
                    info.hasActiveChallengePopup = this.hasActiveChallengePopup(info.id);
                    info.hasChallengeFrame = this.hasChallengeFrame(info.id);
                    if (!info.hasChallengeFrame) {
                        info._type = 'score';
                    }
                }
                return info;
            });
        }
        catch (error) {
            result.error = error;
            return result;
        }
        this.log('findRecaptchas - result', {
            captchaNum: result.captchas.length,
            result
        });
        return result;
    }
    async enterRecaptchaSolutions() {
        const result = {
            solved: [],
            error: null
        };
        try {
            await this._waitUntilDocumentReady();
            const clients = this.getClients();
            this.log('enterRecaptchaSolutions', {
                url: document.location.href,
                hasClients: !!clients,
                solutionNum: this.data.solutions.length
            });
            if (!clients) {
                result.error = 'No recaptchas found';
                return result;
            }
            const solutions = this.data.solutions;
            if (!solutions || !solutions.length) {
                result.error = 'No solutions provided';
                return result;
            }
            result.solved = this.data.solutions.map(solution => {
                const client = this.getClientById(solution.id);
                this.log(' - client', !!client);
                const solved = {
                    _vendor: 'recaptcha',
                    id: client.id,
                    responseElement: false,
                    responseCallback: false
                };
                const $iframe = this._findVisibleIframeNodeById(solved.id);
                this.log(' - $iframe', !!$iframe);
                if (!$iframe) {
                    solved.error = `Iframe not found for id '${solved.id}'`;
                    return solved;
                }
                if (this.hasActiveChallengePopup(solved.id)) {
                    // Hide if present challenge window
                    this._hideChallengeWindowIfPresent(solved.id);
                }
                // Enter solution in response textarea
                const $input = this.getResponseInputById(solved.id);
                this.log(' - $input', !!$input);
                if ($input) {
                    $input.innerHTML = solution.text;
                    solved.responseElement = true;
                }
                // Enter solution in optional callback
                this.log(' - callback', !!client.callback);
                if (client.callback) {
                    try {
                        this.log(' - callback - type', {
                            typeof: typeof client.callback,
                            value: '' + client.callback
                        });
                        if (typeof client.callback === 'function') {
                            client.callback.call(window, solution.text);
                        }
                        else {
                            eval(client.callback).call(window, solution.text); // tslint:disable-line
                            this.log(' - callback - aftereval');
                        }
                        solved.responseCallback = true;
                    }
                    catch (error) {
                        solved.error = error;
                    }
                }
                // Finishing up
                solved.isSolved = solved.responseCallback || solved.responseElement;
                solved.solvedAt = new Date();
                this._paintCaptchaSolved($iframe);
                this.log(' - solved', solved);
                return solved;
            });
        }
        catch (error) {
            result.error = error;
            return result;
        }
        this.log('enterRecaptchaSolutions - finished', result);
        return result;
    }
}
/*
// Example data

{
    "captchas": [{
        "sitekey": "6LdAUwoUAAAAAH44X453L0tUWOvx11XXXXXXXX",
        "id": "lnfy52r0cccc",
        "widgetId": 0,
        "display": {
            "size": null,
            "top": 23,
            "left": 13,
            "width": 28,
            "height": 28,
            "theme": null
        },
        "url": "https://example.com",
        "hasResponseElement": true
    }],
    "error": null
}

{
    "solutions": [{
        "id": "lnfy52r0cccc",
        "provider": "2captcha",
        "providerCaptchaId": "61109548000",
        "text": "03AF6jDqVSOVODT-wLKZ47U0UXz...",
        "requestAt": "2019-02-09T18:30:43.587Z",
        "responseAt": "2019-02-09T18:30:57.937Z"
    }]
    "error": null
}

{
    "solved": [{
        "id": "lnfy52r0cccc",
        "responseElement": true,
        "responseCallback": false,
        "isSolved": true,
        "solvedAt": {}
    }]
    "error": null
}
*/

const ContentScriptDefaultOpts$1 = {
    visualFeedback: true,
};
const ContentScriptDefaultData$1 = {
    solutions: [],
};
/**
 * Content script for Hcaptcha handling (runs in browser context)
 * @note External modules are not supported here (due to content script isolation)
 */
class HcaptchaContentScript {
    constructor(opts = ContentScriptDefaultOpts$1, data = ContentScriptDefaultData$1) {
        this.baseUrl = 'assets.hcaptcha.com/captcha/v1/';
        this.opts = opts;
        this.data = data;
    }
    async _waitUntilDocumentReady() {
        return new Promise(function (resolve) {
            if (!document || !window)
                return resolve(null);
            const loadedAlready = /^loaded|^i|^c/.test(document.readyState);
            if (loadedAlready)
                return resolve(null);
            function onReady() {
                resolve(null);
                document.removeEventListener('DOMContentLoaded', onReady);
                window.removeEventListener('load', onReady);
            }
            document.addEventListener('DOMContentLoaded', onReady);
            window.addEventListener('load', onReady);
        });
    }
    _paintCaptchaBusy($iframe) {
        try {
            if (this.opts.visualFeedback) {
                $iframe.style.filter = `opacity(60%) hue-rotate(400deg)`; // violet
            }
        }
        catch (error) {
            // noop
        }
        return $iframe;
    }
    /** Regular checkboxes */
    _findRegularCheckboxes() {
        const nodeList = document.querySelectorAll(`iframe[src*='${this.baseUrl}'][data-hcaptcha-widget-id]:not([src*='invisible'])`);
        return Array.from(nodeList);
    }
    /** Find active challenges from invisible hcaptchas */
    _findActiveChallenges() {
        const nodeList = document.querySelectorAll(`div[style*='visible'] iframe[src*='${this.baseUrl}'][src*='hcaptcha-challenge.html'][src*='invisible']`);
        return Array.from(nodeList);
    }
    _extractInfoFromIframes(iframes) {
        return iframes
            .map((el) => el.src.replace('.html#', '.html?'))
            .map((url) => {
            const { searchParams } = new URL(url);
            const result = {
                _vendor: 'hcaptcha',
                url: document.location.href,
                id: searchParams.get('id'),
                sitekey: searchParams.get('sitekey'),
                display: {
                    size: searchParams.get('size') || 'normal',
                },
            };
            return result;
        });
    }
    async findRecaptchas() {
        const result = {
            captchas: [],
            error: null,
        };
        try {
            await this._waitUntilDocumentReady();
            const iframes = [
                ...this._findRegularCheckboxes(),
                ...this._findActiveChallenges(),
            ];
            if (!iframes.length) {
                return result;
            }
            result.captchas = this._extractInfoFromIframes(iframes);
            iframes.forEach((el) => {
                this._paintCaptchaBusy(el);
            });
        }
        catch (error) {
            result.error = error;
            return result;
        }
        return result;
    }
    async enterRecaptchaSolutions() {
        const result = {
            solved: [],
            error: null,
        };
        try {
            await this._waitUntilDocumentReady();
            const solutions = this.data.solutions;
            if (!solutions || !solutions.length) {
                result.error = 'No solutions provided';
                return result;
            }
            result.solved = solutions
                .filter((solution) => solution._vendor === 'hcaptcha')
                .filter((solution) => solution.hasSolution === true)
                .map((solution) => {
                window.postMessage(JSON.stringify({
                    id: solution.id,
                    label: 'challenge-closed',
                    source: 'hcaptcha',
                    contents: {
                        event: 'challenge-passed',
                        expiration: 120,
                        response: solution.text,
                    },
                }), '*');
                return {
                    _vendor: solution._vendor,
                    id: solution.id,
                    isSolved: true,
                    solvedAt: new Date(),
                };
            });
        }
        catch (error) {
            result.error = error;
            return result;
        }
        return result;
    }
}

// https://github.com/bochkarev-artem/2captcha/blob/master/index.js
// TODO: Create our own API wrapper
var http = require('http');
var https = require('https');
var url = require('url');
var querystring = require('querystring');
var apiKey;
var apiInUrl = 'http://2captcha.com/in.php';
var apiResUrl = 'http://2captcha.com/res.php';
var SOFT_ID = '2589';
var defaultOptions = {
    pollingInterval: 2000,
    retries: 3
};
function pollCaptcha(captchaId, options, invalid, callback) {
    invalid = invalid.bind({ options: options, captchaId: captchaId });
    var intervalId = setInterval(function () {
        var httpRequestOptions = url.parse(apiResUrl +
            '?action=get&soft_id=' +
            SOFT_ID +
            '&key=' +
            apiKey +
            '&id=' +
            captchaId);
        var request = http.request(httpRequestOptions, function (response) {
            var body = '';
            response.on('data', function (chunk) {
                body += chunk;
            });
            response.on('end', function () {
                if (body === 'CAPCHA_NOT_READY') {
                    return;
                }
                clearInterval(intervalId);
                var result = body.split('|');
                if (result[0] !== 'OK') {
                    callback(result[0]); //error
                }
                else {
                    callback(null, {
                        id: captchaId,
                        text: result[1]
                    }, invalid);
                }
                callback = function () { }; // prevent the callback from being called more than once, if multiple http requests are open at the same time.
            });
        });
        request.on('error', function (e) {
            request.destroy();
            callback(e);
        });
        request.end();
    }, options.pollingInterval || defaultOptions.pollingInterval);
}
const setApiKey = function (key) {
    apiKey = key;
};
const decodeReCaptcha = function (captchaMethod, captcha, pageUrl, extraData, options, callback) {
    if (!callback) {
        callback = options;
        options = defaultOptions;
    }
    var httpRequestOptions = url.parse(apiInUrl);
    httpRequestOptions.method = 'POST';
    var postData = Object.assign({ method: captchaMethod, key: apiKey, soft_id: SOFT_ID, 
        // googlekey: captcha,
        pageurl: pageUrl }, extraData);
    if (captchaMethod === 'userrecaptcha') {
        postData.googlekey = captcha;
    }
    if (captchaMethod === 'hcaptcha') {
        postData.sitekey = captcha;
    }
    postData = querystring.stringify(postData);
    var request = http.request(httpRequestOptions, function (response) {
        var body = '';
        response.on('data', function (chunk) {
            body += chunk;
        });
        response.on('end', function () {
            var result = body.split('|');
            if (result[0] !== 'OK') {
                return callback(result[0]);
            }
            pollCaptcha(result[1], options, function (error) {
                var callbackToInitialCallback = callback;
                report(this.captchaId);
                if (error) {
                    return callbackToInitialCallback('CAPTCHA_FAILED');
                }
                if (!this.options.retries) {
                    this.options.retries = defaultOptions.retries;
                }
                if (this.options.retries > 1) {
                    this.options.retries = this.options.retries - 1;
                    decodeReCaptcha(captchaMethod, captcha, pageUrl, extraData, this.options, callback);
                }
                else {
                    callbackToInitialCallback('CAPTCHA_FAILED_TOO_MANY_TIMES');
                }
            }, callback);
        });
    });
    request.on('error', function (e) {
        request.destroy();
        callback(e);
    });
    request.write(postData);
    request.end();
};
const report = function (captchaId) {
    var reportUrl = apiResUrl +
        '?action=reportbad&soft_id=' +
        SOFT_ID +
        '&key=' +
        apiKey +
        '&id=' +
        captchaId;
    var options = url.parse(reportUrl);
    var request = http.request(options, function (response) {
        // var body = ''
        // response.on('data', function(chunk) {
        //   body += chunk
        // })
        // response.on('end', function() {})
    });
    request.end();
};

const PROVIDER_ID = '2captcha';
const debug = Debug(`puppeteer-extra-plugin:recaptcha:${PROVIDER_ID}`);
const secondsBetweenDates = (before, after) => (after.getTime() - before.getTime()) / 1000;
const providerOptsDefaults = {
    useEnterpriseFlag: false,
    useActionValue: true
};
async function decodeRecaptchaAsync(token, vendor, sitekey, url, extraData, opts = { pollingInterval: 2000 }) {
    return new Promise(resolve => {
        const cb = (err, result, invalid) => resolve({ err, result, invalid });
        try {
            setApiKey(token);
            let method = 'userrecaptcha';
            if (vendor === 'hcaptcha') {
                method = 'hcaptcha';
            }
            decodeReCaptcha(method, sitekey, url, extraData, opts, cb);
        }
        catch (error) {
            return resolve({ err: error });
        }
    });
}
async function getSolutions(captchas = [], token = '', opts = {}) {
    opts = Object.assign(Object.assign({}, providerOptsDefaults), opts);
    const solutions = await Promise.all(captchas.map(c => getSolution(c, token, opts)));
    return { solutions, error: solutions.find(s => !!s.error) };
}
async function getSolution(captcha, token, opts) {
    const solution = {
        _vendor: captcha._vendor,
        provider: PROVIDER_ID
    };
    try {
        if (!captcha || !captcha.sitekey || !captcha.url || !captcha.id) {
            throw new Error('Missing data in captcha');
        }
        solution.id = captcha.id;
        solution.requestAt = new Date();
        debug('Requesting solution..', solution);
        const extraData = {};
        if (captcha.s) {
            extraData['data-s'] = captcha.s; // google site specific property
        }
        if (opts.useActionValue && captcha.action) {
            extraData['action'] = captcha.action; // Optional v3/enterprise action
        }
        if (opts.useEnterpriseFlag && captcha.isEnterprise) {
            extraData['enterprise'] = 1;
        }
        const { err, result, invalid } = await decodeRecaptchaAsync(token, captcha._vendor, captcha.sitekey, captcha.url, extraData);
        debug('Got response', { err, result, invalid });
        if (err)
            throw new Error(`${PROVIDER_ID} error: ${err}`);
        if (!result || !result.text || !result.id) {
            throw new Error(`${PROVIDER_ID} error: Missing response data: ${result}`);
        }
        solution.providerCaptchaId = result.id;
        solution.text = result.text;
        solution.responseAt = new Date();
        solution.hasSolution = !!solution.text;
        solution.duration = secondsBetweenDates(solution.requestAt, solution.responseAt);
    }
    catch (error) {
        debug('Error', error);
        solution.error = error.toString();
    }
    return solution;
}

const BuiltinSolutionProviders = [
    {
        id: PROVIDER_ID,
        fn: getSolutions
    }
];
/**
 * A puppeteer-extra plugin to automatically detect and solve reCAPTCHAs.
 * @noInheritDoc
 */
class PuppeteerExtraPluginRecaptcha extends PuppeteerExtraPlugin {
    constructor(opts) {
        super(opts);
        /** An optional global window object we use for contentscript debug logging */
        this.debugBindingName = '___pepr_cs';
        this.debug('Initialized', this.opts);
        this.contentScriptDebug = this.debug.extend('cs');
    }
    get name() {
        return 'recaptcha';
    }
    get defaults() {
        return {
            visualFeedback: true,
            throwOnError: false,
            solveInViewportOnly: false,
            solveScoreBased: false,
            solveInactiveChallenges: false
        };
    }
    get contentScriptOpts() {
        const { visualFeedback } = this.opts;
        return {
            visualFeedback,
            debugBinding: this.contentScriptDebug.enabled
                ? this.debugBindingName
                : undefined
        };
    }
    _generateContentScript(vendor, fn, data) {
        this.debug('_generateContentScript', vendor, fn, data);
        let scriptSource = RecaptchaContentScript.toString();
        let scriptName = 'RecaptchaContentScript';
        if (vendor === 'hcaptcha') {
            scriptSource = HcaptchaContentScript.toString();
            scriptName = 'HcaptchaContentScript';
        }
        return `(async() => {
      const DATA = ${JSON.stringify(data || null)}
      const OPTS = ${JSON.stringify(this.contentScriptOpts)}

      ${scriptSource}
      const script = new ${scriptName}(OPTS, DATA)
      return script.${fn}()
    })()`;
    }
    /** Based on the user defined options we may want to filter out certain captchas (inactive, etc) */
    _filterRecaptchas(recaptchas = []) {
        const results = recaptchas.map((c) => {
            if (c._type === 'invisible' &&
                !c.hasActiveChallengePopup &&
                !this.opts.solveInactiveChallenges) {
                c.filtered = true;
                c.filteredReason = 'solveInactiveChallenges';
            }
            if (c._type === 'score' && !this.opts.solveScoreBased) {
                c.filtered = true;
                c.filteredReason = 'solveScoreBased';
            }
            if (c._type === 'checkbox' &&
                !c.isInViewport &&
                this.opts.solveInViewportOnly) {
                c.filtered = true;
                c.filteredReason = 'solveInViewportOnly';
            }
            if (c.filtered) {
                this.debug('Filtered out captcha based on provided options', {
                    id: c.id,
                    reason: c.filteredReason,
                    captcha: c
                });
            }
            return c;
        });
        return {
            captchas: results.filter(c => !c.filtered),
            filtered: results.filter(c => c.filtered)
        };
    }
    async findRecaptchas(page) {
        this.debug('findRecaptchas');
        // As this might be called very early while recaptcha is still loading
        // we add some extra waiting logic for developer convenience.
        const hasRecaptchaScriptTag = await page.$(`script[src*="/recaptcha/api.js"], script[src*="/recaptcha/enterprise.js"]`);
        this.debug('hasRecaptchaScriptTag', !!hasRecaptchaScriptTag);
        if (hasRecaptchaScriptTag) {
            this.debug('waitForRecaptchaClient - start', new Date());
            await page
                .waitForFunction(`
        (function() {
          return Object.keys((window.___grecaptcha_cfg || {}).clients || {}).length
        })()
      `, { polling: 200, timeout: 10 * 1000 })
                .catch(this.debug);
            this.debug('waitForRecaptchaClient - end', new Date()); // used as timer
        }
        const hasHcaptchaScriptTag = await page.$(`script[src*="//hcaptcha.com/1/api.js"]`);
        this.debug('hasHcaptchaScriptTag', !!hasHcaptchaScriptTag);
        if (hasHcaptchaScriptTag) {
            this.debug('wait:hasHcaptchaScriptTag - start', new Date());
            await page.waitForFunction(`
        (function() {
          return window.hcaptcha
        })()
      `, { polling: 200, timeout: 10 * 1000 });
            this.debug('wait:hasHcaptchaScriptTag - end', new Date()); // used as timer
        }
        const onDebugBindingCalled = (message, data) => {
            this.contentScriptDebug(message, data);
        };
        if (this.contentScriptDebug.enabled) {
            if ('exposeFunction' in page) {
                await page.exposeFunction(this.debugBindingName, onDebugBindingCalled);
            }
        }
        // Even without a recaptcha script tag we're trying, just in case.
        const resultRecaptcha = (await page.evaluate(this._generateContentScript('recaptcha', 'findRecaptchas')));
        const resultHcaptcha = (await page.evaluate(this._generateContentScript('hcaptcha', 'findRecaptchas')));
        const filterResults = this._filterRecaptchas(resultRecaptcha.captchas);
        this.debug(`Filter results: ${filterResults.filtered.length} of ${filterResults.captchas.length} captchas filtered from results.`);
        const response = {
            captchas: [...filterResults.captchas, ...resultHcaptcha.captchas],
            filtered: filterResults.filtered,
            error: resultRecaptcha.error || resultHcaptcha.error
        };
        this.debug('findRecaptchas', response);
        if (this.opts.throwOnError && response.error) {
            throw new Error(response.error);
        }
        return response;
    }
    async getRecaptchaSolutions(captchas, provider) {
        this.debug('getRecaptchaSolutions', { captchaNum: captchas.length });
        provider = provider || this.opts.provider;
        if (!provider ||
            (!provider.token && !provider.fn) ||
            (provider.token && provider.token === 'XXXXXXX' && !provider.fn)) {
            throw new Error('Please provide a solution provider to the plugin.');
        }
        let fn = provider.fn;
        if (!fn) {
            const builtinProvider = BuiltinSolutionProviders.find(p => p.id === (provider || {}).id);
            if (!builtinProvider || !builtinProvider.fn) {
                throw new Error(`Cannot find builtin provider with id '${provider.id}'.`);
            }
            fn = builtinProvider.fn;
        }
        const response = await fn.call(this, captchas, provider.token, provider.opts || {});
        response.error =
            response.error ||
                response.solutions.find((s) => !!s.error);
        this.debug('getRecaptchaSolutions', response);
        if (response && response.error) {
            console.warn('PuppeteerExtraPluginRecaptcha: An error occured during "getRecaptchaSolutions":', response.error);
        }
        if (this.opts.throwOnError && response.error) {
            throw new Error(response.error);
        }
        return response;
    }
    async enterRecaptchaSolutions(page, solutions) {
        this.debug('enterRecaptchaSolutions', { solutions });
        const hasRecaptcha = !!solutions.find(s => s._vendor === 'recaptcha');
        const solvedRecaptcha = hasRecaptcha
            ? (await page.evaluate(this._generateContentScript('recaptcha', 'enterRecaptchaSolutions', {
                solutions
            })))
            : { solved: [] };
        const hasHcaptcha = !!solutions.find(s => s._vendor === 'hcaptcha');
        const solvedHcaptcha = hasHcaptcha
            ? (await page.evaluate(this._generateContentScript('hcaptcha', 'enterRecaptchaSolutions', {
                solutions
            })))
            : { solved: [] };
        const response = {
            solved: [...solvedRecaptcha.solved, ...solvedHcaptcha.solved],
            error: solvedRecaptcha.error || solvedHcaptcha.error
        };
        response.error = response.error || response.solved.find(s => !!s.error);
        this.debug('enterRecaptchaSolutions', response);
        if (this.opts.throwOnError && response.error) {
            throw new Error(response.error);
        }
        return response;
    }
    async solveRecaptchas(page) {
        this.debug('solveRecaptchas');
        const response = {
            captchas: [],
            filtered: [],
            solutions: [],
            solved: [],
            error: null
        };
        try {
            // If `this.opts.throwOnError` is set any of the
            // following will throw and abort execution.
            const { captchas, filtered, error: captchasError } = await this.findRecaptchas(page);
            response.captchas = captchas;
            response.filtered = filtered;
            if (captchas.length) {
                const { solutions, error: solutionsError } = await this.getRecaptchaSolutions(response.captchas);
                response.solutions = solutions;
                const { solved, error: solvedError } = await this.enterRecaptchaSolutions(page, response.solutions);
                response.solved = solved;
                response.error = captchasError || solutionsError || solvedError;
            }
        }
        catch (error) {
            response.error = error.toString();
        }
        this.debug('solveRecaptchas', response);
        if (this.opts.throwOnError && response.error) {
            throw new Error(response.error);
        }
        return response;
    }
    _addCustomMethods(prop) {
        prop.findRecaptchas = async () => this.findRecaptchas(prop);
        prop.getRecaptchaSolutions = async (captchas, provider) => this.getRecaptchaSolutions(captchas, provider);
        prop.enterRecaptchaSolutions = async (solutions) => this.enterRecaptchaSolutions(prop, solutions);
        // Add convenience methods that wraps all others
        prop.solveRecaptchas = async () => this.solveRecaptchas(prop);
    }
    _addCustomMethodsToPage(page) {
        // Add custom page methods
        this._addCustomMethods(page);
        // Add custom methods to potential frames as well
        page.on('frameattached', (frame) => {
            if (!frame)
                return;
            this._addCustomMethods(frame);
        });
    }
    async onPageCreated(page) {
        this.debug('onPageCreated', page.url());
        // Make sure we can run our content script
        await page.setBypassCSP(true);
        this._addCustomMethodsToPage(page);
    }
    /** Add additions to already existing pages and frames */
    async onBrowser(browser) {
        const pages = await browser.pages();
        for (const page of pages) {
            this._addCustomMethodsToPage(page);
            for (const frame of page.mainFrame().childFrames()) {
                this._addCustomMethods(frame);
            }
        }
    }
}
/** Default export, PuppeteerExtraPluginRecaptcha  */
const defaultExport = (options) => {
    return new PuppeteerExtraPluginRecaptcha(options || {});
};

export default defaultExport;
export { BuiltinSolutionProviders, PuppeteerExtraPluginRecaptcha };
//# sourceMappingURL=index.esm.js.map
