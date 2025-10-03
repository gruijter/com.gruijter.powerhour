export = Widget;
/**
 * This class represents a Widget.
 * This class should not be instanced manually, but retrieved using a method in {@link ManagerDashboards} instead.
 */
declare class Widget {
  /**
   * @typedef {object} Widget.SettingAutocompleteResults
   * @property {string} name
   * @property {string=} description
   * @property {string=} image
   */
  /**
   * @callback Widget.SettingAutocompleteCallback
   * @param {string} query The typed query by the user
   * @param {any} settings The current state of the settings, as selected by the user in the front-end
   * @returns {Promise<Widget.SettingAutocompleteResults> | Widget.SettingAutocompleteResults}
   */
  /**
   * Register a listener for a autocomplete event.
   * This is fired when the widget is of type `autocomplete` and the user typed a query.
   *
   * @param {string} name - name of the desired widget setting.
   * @param {SettingAutocompleteCallback} listener - Should return a promise that resolves to the autocomplete results.
   * @returns {Widget}
   *
   * @example
   * const widget = this.homey.dashboards.getWidget('my-widget')
   *
   * widget.registerSettingAutocompleteListener('composer', async (query, settings) => {
   *   return [
   *     {
   *       name: "Mozart",
   *       // Optionally provide the following properties.
   *       description: "...",
   *       image: "https://some.url/",
   *
   *       // You can freely add additional properties
   *       // that you can access in Homey.getSettings()['mySettingId'].
   *       id: "mozart",
   *     },
   *     {
   *       name: "Amadeus",
   *
   *       // You can freely add additional properties
   *       // that you can access in Homey.getSettings()['mySettingId'].
   *       id: "amadeus",
   *     },
   *   ].filter((item) => item.name.toLowerCase().includes(query.toLowerCase()));
   * });
   */
  registerSettingAutocompleteListener(name: string, listener: Widget.SettingAutocompleteCallback): Widget;
}
declare namespace Widget {
  export { SettingAutocompleteResults, SettingAutocompleteCallback };
}

type SettingAutocompleteResult = {
  name: string;
  description?: string | undefined;
  image?: string | undefined;
  [key: string]: any;
};
type SettingAutocompleteResults = Array<SettingAutocompleteResult>;
type SettingAutocompleteCallback = (query: string, settings: any) => Promise<Widget.SettingAutocompleteResults> | Widget.SettingAutocompleteResults;
