export = ManagerAudio;
/**
 * @hideconstructor
 * @classdesc
 * You can access this manager through the {@link Homey} instance as `this.homey.audio`
 */
declare class ManagerAudio extends Manager {
    static ID: string;
    /**
     * Play WAV audio sample
     * @param {string} sampleId unique id which can be used to play sounds that have been played before
     * @param {Buffer|string} [sample] Buffer containing a WAV audio sample or path to file containing WAV audio sample data.
     * Sample is cached in Homey and can be played again by calling this function with the same sampleId without the sample argument which will result in the the sample loading faster.
     * @returns {Promise<any>}
     */
    playWav(sampleId: string, sample?: string | Buffer | undefined): Promise<any>;
    /**
     * Play MP3 audio sample
     * @param {string} sampleId unique id which can be used to play sounds that have been played before
     * @param {Buffer|string} [sample] Buffer containing a MP3 audio sample or path to file containing MP3 audio sample data.
     * Sample is cached in Homey and can be played again by calling this function with the same sampleId without the sample argument which will result in the the sample loading faster.
     * @returns {Promise<any>}
     */
    playMp3(sampleId: string, sample?: string | Buffer | undefined): Promise<any>;
    /**
     * Remove WAV sample from cache
     * @param {string} sampleId The id of the WAV that is cached
     * @returns {Promise<any>}
     */
    removeWav(sampleId: string): Promise<any>;
    /**
     * Remove MP3 sample from cache
     * @param {string} sampleId The id of the MP3 that is cached
     * @returns {Promise<any>}
     */
    removeMp3(sampleId: string): Promise<any>;
}
import Manager = require("../lib/Manager.js");
