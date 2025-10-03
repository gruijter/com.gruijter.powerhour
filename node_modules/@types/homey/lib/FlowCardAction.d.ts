export = FlowCardAction;
/**
 * @typedef {import('../manager/flow')} ManagerFlow
 */
/**
 * The FlowCardAction class is a programmatic representation of a Flow Card with type `action`, as defined in an app's <code>app.json</code>.
 * @extends FlowCard
 */
declare class FlowCardAction extends FlowCard {
    /**
     * Get the current argument values of this card, as filled in by the user.
     * @returns {Promise<any[]>} A Promise that resolves to an array of key-value objects with the argument's name as key. Every array entry represents one Flow card.
     */
    getArgumentValues(): Promise<any[]>;
}
declare namespace FlowCardAction {
    export { ManagerFlow };
}
import FlowCard = require("./FlowCard.js");
type ManagerFlow = import('../manager/flow');
