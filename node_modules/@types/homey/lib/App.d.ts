export = App;
/**
 * The App class is your start point for any app.
 * This class should be extended and exported from `app.js`.
 * Methods prefixed with `on` are meant to be overriden.
 * It is not allowed to overwrite the constructor.
 * @extends SimpleClass
 * @example <caption>/app.js</caption>
 * const Homey = require('homey');
 *
 * class MyApp extends Homey.App {
 *   async onInit() {
 *     this.log('MyApp has been initialized');
 *   }
 * }
 *
 * module.exports = MyApp;
 */
declare class App extends SimpleClass {
    /**
     * The Homey instance of this app
     * @type {Homey}
     */
    homey: Homey;
    /**
     * The app.json manifest
     * @type {any} */
    manifest: any;
    /**
     * The app id
     * @type {string} */
    id: string;
    /**
     * The app sdk version
     * @type {number} */
    sdk: number;
    /**
     * This method is called upon initialization of your app.
     */
    onInit(): Promise<void>;
    /**
     * This method is called when your app is destroyed.
     */
    onUninit(): Promise<void>;
}
import SimpleClass = require("./SimpleClass.js");
type Homey = import('./Homey');
