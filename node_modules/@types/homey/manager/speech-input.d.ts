export = ManagerSpeechInput;
/**
 * @typedef {import('../lib/Device')} Device
 */
/**
  * @typedef {object} ManagerSpeechInput.Chunk
  * @property {string} transcript - The chunk text
  * @property {number} startWord - The index of the words array where the chunk starts
  * @property {number} endWord - The index of the words array where the chunk ends
  * @property {string} type - The chunk type - either NP (Noun Phrase) or VP (Verb Phrase)
  */
/**
  * @typedef {object} ManagerSpeechInput.Location
  * @property {string} transcript - The location name
  * @property {number} startWord - The index of the words array where the location starts
  * @property {number} endWord - The index of the words array where the location ends
  */
/**
  * @typedef {object} ManagerSpeechInput.Time
  * @property {string} transcript - The time text
  * @property {number} startWord - The index of the words array where the time mention starts
  * @property {number} endWord - The index of the words array where the time mention ends
  * @property {object} time - The chunk type - either NP (Noun Phrase) or VP (Verb Phrase)
  * @property {number} time[].second - Seconds. False if no reference to a specific second was made
  * @property {number} time[].minute - Minutes. False if no reference to a specific minute was made
  * @property {number} time[].hour - Hour of the day. False if no reference to a specific hour was made
  * @property {boolean} time[].fuzzyHour - Indicates whether there is uncertainty about a time being am or pm. True if there is uncertainty, false if the part of day was indicated
  * @property {number} time[].day - Day of the month. False if no reference to a specific day was made
  * @property {number} time[].month - Month number. 0 is january. False if no reference to a specific month was made
  * @property {number} time[].year - Year. False if no reference to a specific year was made
  */
/**
 * @typedef {object} ManagerSpeechInput.Word
 * @property {string} word - The word
 * @property {string} posTag - The part-of-speech tag assigned to the word, using universal dependencies tagset
 * @property {ManagerSpeechInput.Chunk[]} chunks - lists any chunks starting at this word. Stuctured the same as the Object in speech.chunks[]
 * @property {ManagerSpeechInput.Location[]} locations - lists any locations starting at this word. Stuctured the same as the Object in speech.locations[]
 * @property {ManagerSpeechInput.Time[]} times - lists any times starting at this word. Stuctured the same as the Object in speech.times[]
 * @property {object} devices - lists any device mentions starting at this word. Stuctured the same as the Object in speech.devices[]
 */
/**
 * @hideconstructor
 * @classdesc
 * You can access this manager through the {@link Homey} instance as `this.homey.speechInput`
 */
declare class ManagerSpeechInput extends Manager {
    static ID: string;
    /**
     * This event is fired when a speech query has been received, and needs feedback.
     * @event ManagerSpeechInput#speechEval
     * @param {object} speech - Information about what the user said
     * @param {string} speech.session - The session where the speech command originated from
     * @param {string} speech.transcript - The detected user thrase
     * @param {object} speech.matches - a dynamically generated tree containing all the matched Groups and Elements
     * @param {ManagerSpeechInput.Word[]} speech.words - An array of Objects, where each Object contains the word's properties
     * @param {ManagerSpeechInput.Chunk[]} speech.chunks - An array of detected noun phrases and verb phrases
     * @param {ManagerSpeechInput.Location[]} speech.locations - An array of detected references to a location
     * @param {ManagerSpeechInput.Time[]} speech.times - An array of detected time references
     * @param {Device[]} speech.devices - An array of {@link Device} instances which match the device parameters specified in app.json
     * @param {string} speech.allZones - A structured phrase which can be used to provide user feedback about the detected Zone names. Format: "in the {zone_name}(, {zone_name})*( and the {zone_name})?"
     * @param {Function} callback - A truthy response is used to indicate that your App can process this transcript. The returned value will be passed on to the onSpeechMatch event
     */
    /**
     * @event ManagerSpeechInput#speechMatch
     * @param {object} speech - Information about what the user said
     * @param {string} speech.session - The session where the speech command originated from
     * @param {string} speech.transcript - The detected user thrase
     * @param {object} speech.matches - a dynamically generated tree containing all the matched Groups and Elements
     * @param {ManagerSpeechInput.Word[]} speech.words - An array of Objects, where each Object contains the word's properties
     * @param {ManagerSpeechInput.Chunk[]} speech.chunks - An array of detected noun phrases and verb phrases
     * @param {ManagerSpeechInput.Location[]} speech.locations - An array of detected references to a location
     * @param {ManagerSpeechInput.Time[]} speech.times - An array of detected time references
     * @param {Device[]} speech.devices - An array of {@link Device} instances which match the device parameters specified in app.json
     * @param {string} speech.allZones - A structured phrase which can be used to provide user feedback about the detected Zone names. Format: "in the {zone_name}(, {zone_name})*( and the {zone_name})?"
     * @param {any} onSpeechData The result from {@link ManagerSpeechInput#event:speechEval speechEval}
     */
    /**
     * Let Homey ask a question. There is a limit of 255 characters.
     *
     * > Requires the `homey:manager:speech-input` and/or `homey:manager:speech-output` permissions.
     * > For more information about permissions read the [Permissions tutorial](https://app.gitbook.com/@athom/s/homey-apps/the-basics/app/permissions).
     *
     * @param {string} text - The sentence to say
     * @param {object} opts
     * @param {object} [opts.session] - The session of the speech. Leave empty to use Homey's built-in speaker
     * @param {number} [opts.timeout] - Amount of seconds until the response has timed-out
     * @returns {Promise<string>} - The text of the answer
     */
    ask(text: string, opts: {
        session?: object | undefined;
        timeout?: number | undefined;
    }): Promise<string>;
    /**
     * Let Homey ask a Yes/No question. There is a limit of 255 characters.
     *
     * > Requires the `homey:manager:speech-input` and/or `homey:manager:speech-output` permissions.
     * > For more information about permissions read the [Permissions tutorial](https://app.gitbook.com/@athom/s/homey-apps/the-basics/app/permissions).
     *
     * @param {string} text - The sentence to say
     * @param {object} opts
     * @param {object} [opts.session] - The session of the speech. Leave empty to use Homey's built-in speaker
     * @param {number} [opts.timeout] - Amount of seconds until the response has timed-out
     * @returns {Promise<boolean>} - Indicating whether the user answered with yes (true) or no (false)
     */
    confirm(text: string, opts: {
        session?: object | undefined;
        timeout?: number | undefined;
    }): Promise<boolean>;
}
declare namespace ManagerSpeechInput {
    export { Chunk, Location, Time, Word, Device };
}
import Manager = require("../lib/Manager.js");
type Chunk = {
    /**
     * - The chunk text
     */
    transcript: string;
    /**
     * - The index of the words array where the chunk starts
     */
    startWord: number;
    /**
     * - The index of the words array where the chunk ends
     */
    endWord: number;
    /**
     * - The chunk type - either NP (Noun Phrase) or VP (Verb Phrase)
     */
    type: string;
};
type Location = {
    /**
     * - The location name
     */
    transcript: string;
    /**
     * - The index of the words array where the location starts
     */
    startWord: number;
    /**
     * - The index of the words array where the location ends
     */
    endWord: number;
};
type Time = {
    /**
     * - The time text
     */
    transcript: string;
    /**
     * - The index of the words array where the time mention starts
     */
    startWord: number;
    /**
     * - The index of the words array where the time mention ends
     */
    endWord: number;
    /**
     * - The chunk type - either NP (Noun Phrase) or VP (Verb Phrase)
     */
    time: {
        second: number;
        minute: number;
        hour: number;
        fuzzyHour: boolean;
        day: number;
        month: number;
        year: number;
    };
};
type Word = {
    /**
     * - The word
     */
    word: string;
    /**
     * - The part-of-speech tag assigned to the word, using universal dependencies tagset
     */
    posTag: string;
    /**
     * - lists any chunks starting at this word. Stuctured the same as the Object in speech.chunks[]
     */
    chunks: ManagerSpeechInput.Chunk[];
    /**
     * - lists any locations starting at this word. Stuctured the same as the Object in speech.locations[]
     */
    locations: ManagerSpeechInput.Location[];
    /**
     * - lists any times starting at this word. Stuctured the same as the Object in speech.times[]
     */
    times: ManagerSpeechInput.Time[];
    /**
     * - lists any device mentions starting at this word. Stuctured the same as the Object in speech.devices[]
     */
    devices: object;
};
type Device = import('../lib/Device');
