export = FlowCardTrigger;
/**
 * @typedef {import('../manager/flow')} ManagerFlow
 */
/**
 * The FlowCardTrigger class is a programmatic representation of a Flow Card with type `trigger`, as defined in an app's <code>app.json</code>.
 * @extends FlowCard
 */
declare class FlowCardTrigger extends FlowCard {
    /**
     * Trigger this card to start a Flow
     * @param {object=} tokens - An object with tokens and their typed values, as defined in an app's <code>app.json</code>
     * @param {object=} state - An object with properties which are accessible throughout the Flow
     * @returns {Promise<any>} Promise resolves when flow is triggered
     */
     trigger(tokens?: object | undefined, state?: object | undefined): Promise<any>;
    /**
     * Get the current argument values of this card, as filled in by the user.
     * @returns {Promise<any[]>} A Promise that resolves to an array of key-value objects with the argument's name as key. Every array entry represents one Flow card.
     */
    getArgumentValues(): Promise<any[]>;
}
declare namespace FlowCardTrigger {
    export { ManagerFlow };
}
import FlowCard = require("./FlowCard.js");
type ManagerFlow = import('../manager/flow');
