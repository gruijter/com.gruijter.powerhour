export = CloudWebhook;
/**
 * A webhook class that can receive incoming messages
 */
declare class CloudWebhook extends SimpleClass {
    id: string;
    secret: string;
    data: object;
    /**
     * This event is fired when a webhook message has been received.
     * @event CloudWebhook#message
     * @param {object} args
     * @param {object} args.headers - Received HTTP headers
     * @param {object} args.query - Received HTTP query string
     * @param {object} args.body - Received HTTP body
     */
    /**
     * Unregister the webhook.
     * This is a shortcut for {@link ManagerCloud#unregisterWebhook}
     * @returns {Promise<any>}
     */
    unregister(): Promise<any>;
    toJSON(): {
        id: string;
        secret: string;
        data: object;
    };
}
import SimpleClass = require("./SimpleClass.js");
