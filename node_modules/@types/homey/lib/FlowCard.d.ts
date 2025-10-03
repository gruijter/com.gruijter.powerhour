export = FlowCard;
/**
 * @typedef {import('../manager/flow')} ManagerFlow
 */
/**
 * The FlowCard class is a programmatic representation of a Flow card, as defined in the app's `/app.json`.
 */
declare class FlowCard extends SimpleClass {
    id: string;
    type: "trigger" | "condition" | "action";
    manifest: any;
    /**
     * This event is fired when the card is updated by the user (e.g. a Flow has been saved).
     *
     * @event FlowCard#update
     */
    /**
     * @typedef {object} FlowCard.ArgumentAutocompleteResults
     * @property {string} name
     * @property {string=} description
     * @property {string=} icon
     * @property {string=} image
     */
    /**
     * @callback FlowCard.ArgumentAutocompleteCallback
     * @param {string} query The typed query by the user
     * @param {any} args The current state of the arguments, as selected by the user in the front-end
     * @returns {Promise<FlowCard.ArgumentAutocompleteResults> | FlowCard.ArgumentAutocompleteResults}
     */
    /**
     * Register a listener for a autocomplete event of a specific flow card argument.
     * This is fired when the argument is of type `autocomplete` and the user typed a query.
     *
     * @param {string} name - name of the desired flow card argument.
     * @param {FlowCard.ArgumentAutocompleteCallback} listener - Should return a promise that resolves to the autocomplete results.
     * @returns {FlowCard}
     *
     * @example
     * const myActionCard = this.homey.flow.getActionCard('my_action');
     *
     * myActionCard.registerArgumentAutocompleteListener('my_arg', async (query, args) => {
     *   const results = [
     *     {
     *       name: 'Value name',
     *       description: 'Optional description',
     *       icon: 'https://path.to/icon.svg',
     *       // For images that are not svg use:
     *       // image: 'https://path.to/icon.png',
     *
     *       // You can freely add additional properties to access in registerRunListener
     *       id: '...',
     *     },
     *   ];

     *   // filter based on the query
     *   return results.filter((result) => {
     *     return result.name.toLowerCase().includes(query.toLowerCase());
     *   });
     * });
     */
    registerArgumentAutocompleteListener(name: string, listener: FlowCard.ArgumentAutocompleteCallback): FlowCard;
    /**
     * @param {string} name the flow card argument name
     * @returns {FlowArgument}
     */
    getArgument(name: string): FlowArgument;
    /**
     * @callback FlowCard.RunCallback
     * @param {any} args The arguments of the Flow Card, with keys as defined in the `/app.json` and values as specified by the user
     * @param {any} state The state of the Flow
     * @returns {Promise<any> | any}
     */
    /**
     * Register a listener for a run event.
     * @param {FlowCard.RunCallback} listener - Should return a promise that resolves to the FlowCards run result
     * @returns {FlowCard}
     */
    registerRunListener(listener: FlowCard.RunCallback): FlowCard;
}
declare namespace FlowCard {
    export { ArgumentAutocompleteResults, ArgumentAutocompleteCallback, RunCallback, ManagerFlow };
}
import SimpleClass = require("./SimpleClass.js");
import FlowArgument = require("./FlowArgument.js");
type ManagerFlow = import('../manager/flow');

type ArgumentAutocompleteResult = {
  name: string;
  description?: string | undefined;
  icon?: string | undefined;
  image?: string | undefined;
  [key: string]: any;
}

type ArgumentAutocompleteResults = Array<ArgumentAutocompleteResult>;
type ArgumentAutocompleteCallback = (query: string, args: any) => Promise<FlowCard.ArgumentAutocompleteResults> | FlowCard.ArgumentAutocompleteResults;
type RunCallback = (args: any, state: any) => Promise<any> | any;
