export = ManagerCloud;
/**
 * @hideconstructor
 * @classdesc
 * You can access this manager through the {@link Homey} instance as `this.homey.cloud`
 */
declare class ManagerCloud extends Manager {
    static ID: string;
    /**
     * Generate a OAuth2 Callback
     * @param {string} apiUrl
     * @returns {Promise<CloudOAuth2Callback>}
     */
    createOAuth2Callback(apiUrl: string): Promise<CloudOAuth2Callback>;
    /**
     * @param {string} id Webhook ID
     * @param {string} secret Webhook Secret
     * @param {object} data Webhook Data
     * @returns {Promise<CloudWebhook>}
     */
    createWebhook(id: string, secret: string, data: object): Promise<CloudWebhook>;
    /**
     * Unregister a webhook
     * @param {CloudWebhook} webhook
     * @returns {Promise<any>}
     */
    unregisterWebhook(webhook: CloudWebhook): Promise<any>;
    /**
     * Get Homey's local address & port
     * @returns {Promise<string>} A promise that resolves to the local address
     */
    getLocalAddress(): Promise<string>;
    /**
     * Get Homey's Cloud ID
     * @returns {Promise<string>} A promise that resolves to the cloud id
     */
    getHomeyId(): Promise<string>;
}
import Manager = require("../lib/Manager.js");
import CloudOAuth2Callback = require("../lib/CloudOAuth2Callback.js");
import CloudWebhook = require("../lib/CloudWebhook.js");
