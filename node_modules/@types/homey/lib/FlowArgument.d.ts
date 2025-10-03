export = FlowArgument;
/**
 * @typedef {import('./FlowCard').ArgumentAutocompleteCallback} ArgumentAutocompleteCallback
 */
/**
 * The FlowArgument class represents an argument for a Flow Card as defined in the app's `app.json`.
 * This class must not be initiated by the developer, but retrieved by calling {@link FlowCard#getArgument}.
 */
declare class FlowArgument extends SimpleClass {
    /**
     * Register a listener for a autocomplete event.
     * This is fired when the argument is of type `autocomplete` and the user typed a query.
     *
     * @param {ArgumentAutocompleteCallback} listener - Should return a promise that resolves to the autocomplete results.
     * @returns {FlowArgument}
     *
     * @example
     * const myActionCard = this.homey.flow.getActionCard('my_action');
     *
     * const myActionCardMyArg = myAction.getArgument('my_arg');
     *
     * myActionCardMyArg.registerAutocompleteListener(async (query, args) => {
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
     *
     *   // filter based on the query
     *   return results.filter((result) => {
     *     return result.name.toLowerCase().includes(query.toLowerCase());
     *   });
     * });
     */
    registerAutocompleteListener(listener: ArgumentAutocompleteCallback): FlowArgument;
}
declare namespace FlowArgument {
    export { ArgumentAutocompleteCallback };
}
import SimpleClass = require("./SimpleClass.js");
type ArgumentAutocompleteCallback = import('./FlowCard').ArgumentAutocompleteCallback;
