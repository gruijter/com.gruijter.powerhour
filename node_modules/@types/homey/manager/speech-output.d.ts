export = ManagerSpeechOutput;
/**
 * @hideconstructor
 * @classdesc
 * You can access this manager through the {@link Homey} instance as `this.homey.speechOutput`
 */
declare class ManagerSpeechOutput extends Manager {
    static ID: string;
    /**
     * Let Homey say something. There is a limit of 255 characters.
     *
     * > Requires the `homey:manager:speech`-output permission.
     * > For more information about permissions read the [Permissions tutorial](https://app.gitbook.com/@athom/s/homey-apps/the-basics/app/permissions).
     *
     * @param {string} text - The sentence to say
     * @param {object} opts
     * @param {object} opts.session - The session of the speech. Leave empty to use Homey's built-in speaker
     * @returns {Promise<any>}
     * @example
     * this.homey.speechOutput.say('Hello world!')
     *   .then(this.log)
     *   .catch(this.error);
     */
    say(text: string, opts: {
        session: object;
    }): Promise<any>;
}
import Manager = require("../lib/Manager.js");
