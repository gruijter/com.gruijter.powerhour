export = SignalInfrared;
/**
 * @typedef {import('../manager/rf')} ManagerRF
 */
/**
 * The SignalInfrared class represents an Infrared Signal
 * @extends Signal
 */
declare class SignalInfrared extends Signal {

}
declare namespace SignalInfrared {
    export { ManagerRF };
}
import Signal = require("./Signal.js");
type ManagerRF = import('../manager/rf');
