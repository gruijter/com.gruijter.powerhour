export = Signal433;
/**
 * @typedef {import('../manager/rf')} ManagerRF
 */
/**
 * The Signal433 class represents an 433 MHz Signal
 * @extends Signal
 */
declare class Signal433 extends Signal {

}
declare namespace Signal433 {
    export { ManagerRF };
}
import Signal = require("./Signal.js");
type ManagerRF = import('../manager/rf');
