export = CloudOAuth2Callback;
/**
 * A OAuth2 Callback class that can be used to log-in using OAuth2
 * @example
 * let myOAuth2Callback = await this.homey.cloud.createOAuth2Callback(apiUrl);
 *
 * myOAuth2Callback
 *   .on('url', url => {
 *     // the URL which should open in a popup for the user to login
 *   })
 *   .on('code', code => {
 *     // ... swap your code here for an access token
 *   });
 */
declare class CloudOAuth2Callback extends SimpleClass {
    url: string;
    /**
     * This event is fired when a URL has been received.
     * The user must be redirected to this URL to complete the sign-in process.
     * @event CloudOAuth2Callback#url
     * @param {string} url - The absolute URL to the sign-in page
     */
    /**
     * This event is fired when a OAuth2 code has been received.
     * The code can usually be swapped by the app for an access token.
     * @event CloudOAuth2Callback#code
     * @param {String|Error} code - The OAuth2 code, or an Error when something went wrong
     */
}
import SimpleClass = require("./SimpleClass.js");
