export = ManagerNFC;
/**
 * @hideconstructor
 * @classdesc
 * You can access this manager through the {@link Homey} instance as `this.homey.nfc`
 */
declare class ManagerNFC extends Manager {
    static ID: string;
    /**
     * This event is fired when a tag has been found.
     *
     * > Requires the `homey:wireless:nfc` permission.
     * > For more information about permissions read the [Permissions tutorial](https://app.gitbook.com/@athom/s/homey-apps/the-basics/app/permissions).
     *
     * @param {object} tag - The arguments as provided by the user in the Flow Editor
     * @param {object} tag.uid - The UID of the tag
     * @event ManagerNFC#tag
     */
}
import Manager = require("../lib/Manager.js");
