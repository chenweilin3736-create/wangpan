/**
 * 工厂函数：根据 Token 数量自动选择 TelegramAPI 或 TelegramAPIPool
 * @param {string} botToken - 单个或逗号分隔的多个 Bot Token
 * @param {string} proxyUrl - 代理域名（所有 Token 共用）
 * @returns {TelegramAPI|TelegramAPIPool}
 */
export function createTelegramAPI(botToken, proxyUrl = '') {
    const tokens = botToken.split(',').map(t => t.trim()).filter(Boolean);
    if (tokens.length > 1) {
        return new TelegramAPIPool(tokens, proxyUrl);
    }
    return new TelegramAPI(tokens[0], proxyUrl);
}

/**
 * 多 Bot Token 池 — 轮换选取 + 限速自动切换
 * 当某个 Bot 触发 429/FLOOD_WAIT 时，自动切到下一个 Bot
 */
export class TelegramAPIPool {
    constructor(tokens, proxyUrl = '') {
        this.instances = tokens.map(t => new TelegramAPI(t, proxyUrl));
        this.currentIndex = 0;
    }

    /**
     * 轮换（Round-Robin）选取下一个 Bot 实例
     */
    getNextInstance() {
        const instance = this.instances[this.currentIndex];
        this.currentIndex = (this.currentIndex + 1) % this.instances.length;
        return instance;
    }

    /**
     * 智能发送文件：用当前 Bot 发送，被限速则自动切下一个
     * 参数签名与 TelegramAPI.sendFile 一致
     */
    async sendFile(file, chatId, functionName, functionType, caption = '', fileName = '', retryCount = 0) {
        const MAX_POOL_RETRIES = this.instances.length * 3; // 每个 Bot 最多被尝试 3 次
        const available = [...this.instances]; // 可用 Bot 列表（副本）
        let lastError = null;

        for (let attempt = 0; attempt < MAX_POOL_RETRIES && available.length > 0; attempt++) {
            const instance = this.getNextInstance();
            
            // 如果当前实例不在可用列表中，跳过
            if (!available.includes(instance)) {
                continue;
            }

            try {
                const result = await instance.sendFile(file, chatId, functionName, functionType, caption, fileName);
                return result;
            } catch (e) {
                const msg = e.message || '';
                if (msg.includes('429') || msg.includes('FLOOD_WAIT')) {
                    // 该 Bot 被限速，从可用列表中移除
                    console.warn(`TelegramAPIPool: Bot rate-limited, switching to next. Error: ${msg}`);
                    const idx = available.indexOf(instance);
                    if (idx > -1) available.splice(idx, 1);
                    lastError = e;
                    continue;
                }
                throw e; // 非限速错误直接抛出
            }
        }

        throw lastError || new Error('TelegramAPIPool: all bots rate-limited');
    }

    /**
     * 获取文件信息（委托给第一个实例，所有 Bot 都能访问同一文件）
     */
    getFileInfo(responseData) {
        return this.instances[0].getFileInfo(responseData);
    }

    /**
     * 获取文件路径
     */
    async getFilePath(fileId) {
        // 尝试所有实例，直到找到文件
        for (const instance of this.instances) {
            try {
                const path = await instance.getFilePath(fileId);
                if (path) return path;
            } catch (e) {
                // 继续尝试下一个
            }
        }
        return null;
    }

    /**
     * 获取文件内容
     */
    async getFileContent(fileId) {
        // 尝试所有实例
        for (const instance of this.instances) {
            try {
                return await instance.getFileContent(fileId);
            } catch (e) {
                // 继续尝试下一个
            }
        }
        throw new Error(`File not found on any bot: ${fileId}`);
    }
}

/**
 * Telegram API 封装类
 */
export class TelegramAPI {
    constructor(botToken, proxyUrl = '') {
        this.botToken = botToken;
        this.proxyUrl = proxyUrl;
        // 如果设置了代理域名，使用代理域名，否则使用官方 API
        const apiDomain = proxyUrl ? `https://${proxyUrl}` : 'https://api.telegram.org';
        this.baseURL = `${apiDomain}/bot${this.botToken}`;
        this.fileDomain = proxyUrl ? `https://${proxyUrl}` : 'https://api.telegram.org';
        this.defaultHeaders = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0"
        };
    }

    /**
     * 发送文件到Telegram
     * @param {File} file - 要发送的文件
     * @param {string} chatId - 聊天ID
     * @param {string} functionName - API方法名（如：sendPhoto, sendDocument等）
     * @param {string} functionType - 文件类型参数名（如：photo, document等）
     * @returns {Promise<Object>} API响应结果
     */
    async sendFile(file, chatId, functionName, functionType, caption = '', fileName = '', retryCount = 0) {
        const MAX_RETRIES = 3;
        const formData = new FormData();

        formData.append('chat_id', chatId);
        if (fileName) {
            formData.append(functionType, file, fileName);
        } else {
            formData.append(functionType, file);
        }
        if (caption) {
            formData.append('caption', caption);
        }

        const response = await fetch(`${this.baseURL}/${functionName}`, {
            method: 'POST',
            headers: this.defaultHeaders,
            body: formData
        });
        console.log('Telegram API response:', response.status, response.statusText);

        // Handle 429 Too Many Requests (rate limiting)
        if (response.status === 429) {
            const retryAfter = response.headers.get('Retry-After');
            const waitSeconds = retryAfter ? parseInt(retryAfter, 10) : 30;
            console.warn(`Telegram 429 rate limited, waiting ${waitSeconds}s before retry ${retryCount + 1}/${MAX_RETRIES}`);
            if (retryCount < MAX_RETRIES) {
                await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
                return this.sendFile(file, chatId, functionName, functionType, caption, fileName, retryCount + 1);
            }
            throw new Error(`Telegram API rate limited after ${MAX_RETRIES} retries`);
        }

        // Parse response body even on non-200 to check for FLOOD_WAIT
        let responseData;
        try {
            responseData = await response.json();
        } catch (e) {
            responseData = { ok: false, description: response.statusText };
        }

        // Handle FLOOD_WAIT error (Telegram returns 200 with error_code 429)
        if (!responseData.ok && responseData.error_code === 429) {
            const description = responseData.description || '';
            const floodMatch = description.match(/FLOOD_WAIT_(\d+)/);
            const waitSeconds = floodMatch ? parseInt(floodMatch[1], 10) : 30;
            console.warn(`Telegram FLOOD_WAIT ${waitSeconds}s, retry ${retryCount + 1}/${MAX_RETRIES}`);
            if (retryCount < MAX_RETRIES) {
                await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
                return this.sendFile(file, chatId, functionName, functionType, caption, fileName, retryCount + 1);
            }
            throw new Error(`Telegram FLOOD_WAIT after ${MAX_RETRIES} retries`);
        }

        if (!response.ok && !responseData.ok) {
            throw new Error(`Telegram API error: ${responseData.description || response.statusText}`);
        }

        return responseData;
    }

    /**
     * 获取文件信息
     * @param {Object} responseData - Telegram API响应数据
     * @returns {Object|null} 文件信息对象或null
     */
    getFileInfo(responseData) {
        const getFileDetails = (file) => ({
            file_id: file.file_id,
            file_name: file.file_name || file.file_unique_id,
            file_size: file.file_size,
        });

        try {
            if (!responseData.ok) {
                console.error('Telegram API error:', responseData.description);
                return null;
            }

            if (responseData.result.photo) {
                const largestPhoto = responseData.result.photo.reduce((prev, current) =>
                    (prev.file_size > current.file_size) ? prev : current
                );
                return getFileDetails(largestPhoto);
            }

            if (responseData.result.video) {
                return getFileDetails(responseData.result.video);
            }

            if (responseData.result.audio) {
                return getFileDetails(responseData.result.audio);
            }

            if (responseData.result.document) {
                return getFileDetails(responseData.result.document);
            }

            return null;
        } catch (error) {
            console.error('Error parsing Telegram response:', error.message);
            return null;
        }
    }

    /**
     * 获取文件路径
     * @param {string} fileId - 文件ID
     * @returns {Promise<string|null>} 文件路径或null
     */
    async getFilePath(fileId) {
        try {
            const url = `${this.baseURL}/getFile?file_id=${fileId}`;
            const response = await fetch(url, {
                method: 'GET',
                headers: this.defaultHeaders,
            });

            const responseData = await response.json();
            if (responseData.ok) {
                return responseData.result.file_path;
            } else {
                return null;
            }
        } catch (error) {
            console.error('Error getting file path:', error.message);
            return null;
        }
    }

    /**
     * 获取文件内容
     * @param {string} fileId - 文件ID
     * @returns {Promise<Response>} 文件响应
     */
    async getFileContent(fileId) {
        const filePath = await this.getFilePath(fileId);
        if (!filePath) {
            throw new Error(`File path not found for fileId: ${fileId}`);
        }

        const fullURL = `${this.fileDomain}/file/bot${this.botToken}/${filePath}`;
        const response = await fetch(fullURL, {
            headers: this.defaultHeaders
        });

        return response;
    }

}