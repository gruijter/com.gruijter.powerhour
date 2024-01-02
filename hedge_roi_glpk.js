/*
Copyright 2019 - 2024, Robin de Gruijter (gruijter@hotmail.com)

This file is part of com.gruijter.powerhour.

com.gruijter.powerhour is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

com.gruijter.powerhour is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with com.gruijter.powerhour.  If not, see <http://www.gnu.org/licenses/>.
*/

'use strict';

const GLPK = require('glpk.js');

// returns the best trading strategy for all known coming hours
const getStrategy = ({
	prices,	// array of hourly prices, e.g. [0.331, 0.32, 0.322, 0.32, 0.328, 0.339, 0.429, 0.331, 0.32, 0.322, 0.32, 0.328, 0.339, 0.429];
	minPriceDelta = 0.1,	// mimimum price difference to sell/buy. Should include 2x fixed costs per kWh for break even.
	soc = 0,	// Battery State of Charge at start of first hour in %
	startMinute = 0, // minute of the first hour to start the calculation
	batCapacity = 5.05, // kWh, defaults to Sessy value
	chargeSpeeds = [	// defaults to Sessy values
		{
			power: 2200, // Watt. Max speed charging power in Watt (on AC side), loss is included
			eff: 0.9, // efficiency when using Max speed charging
		},
		{
			power: 1050, // Watt. Efficient charging power in Watt (on AC side), loss is included
			eff: 0.95, // efficiency when using Efficient charging
		},
	],
	dischargeSpeeds = [	// defaults to Sessy values
		{
			power: 1700, // Max speed discharging power in Watt (on DC side!), loss is not included
			eff: 0.92, // efficiency when using Max speed discharging
		},
		{
			power: 765, // Efficient discharging power in Watt. (on DC side!), loss is not included
			eff: 0.96, // efficiency when using Efficient discharging
		},
	],
	cleanUpStrategy = true,
}) => {
	const glpk = GLPK();
	const fc = minPriceDelta * 0.5; // fixed cost per kW charging or discharging, e.g. for system write off
	const maxSoC = batCapacity; // kWh
	const minSoC = 0; // kWh
	const startSoC = (soc / 100) * batCapacity; // kWh (when 0, the battery is empty at start)

	const modelOptions = {
		msglev: glpk.GLP_MSG_ERR, // GLP_MSG_ON / OFF / ALL / ERR / DBG
		presol: true,
		// cb: {
		// 	call: (progress) => console.log(progress),
		// 	each: 1,
		// },
	};

	const model = {
		name: 'LP',
		objective: {
			direction: glpk.GLP_MIN,
			name: 'totalCost',
			vars: [],
		},
		binaries: [],
		generals: [],
		subjectTo: [],
		bounds: [],
	};

	// add iterative stuff

	[...prices].forEach((price, hourIdx) => {
		// build objective function (minimize totalCost)
		// charge cost per hour is chargeTime(hrs) * (power(kWh)) * (fixed cost(per kWh) + hourPrice)
		// assume efficiency is on DC side, so incoming power cost is not affected by efficiency
		[...chargeSpeeds].forEach((speed, csIdx) => {
			const chargeCost = { name: `cs${csIdx}T${hourIdx}`, coef: ((speed.power / 1000) * (fc + price)) };
			model.objective.vars.push(chargeCost);
		});
		// discharge cost per period is dischargeTime(hrs) * (power(kWh) * efficiency) * (fixed cost(per kWh) - hourPrice)
		// assume efficiency is on DC side, so outgoing power cost is affected by efficiency
		[...dischargeSpeeds].forEach((speed, dsIdx) => {
			const dischargeCost = { name: `ds${dsIdx}T${hourIdx}`, coef: ((speed.power / 1000) * speed.eff * (fc - price)) };
			model.objective.vars.push(dischargeCost);
		});

		// build generals

		// build constraints
		// any one hour can not be charged/discharged more then 1 hour
		const timeLeftinHour = hourIdx !== 0 ? 1 : (60 - startMinute) / 60; // for first hour use only minutes that are left
		const chargesDischarges = {
			name: `chargesDischarges${hourIdx}`,
			vars: [],
			bnds: { type: glpk.GLP_UP, ub: timeLeftinHour, lb: 0 },
		};
		[...chargeSpeeds].forEach((speed, csIdx) => {
			chargesDischarges.vars.push({ name: `cs${csIdx}T${hourIdx}`, coef: 1 });
		});
		[...dischargeSpeeds].forEach((speed, dsIdx) => {
			chargesDischarges.vars.push({ name: `ds${dsIdx}T${hourIdx}`, coef: 1 });
		});
		model.subjectTo.push(chargesDischarges);

		// SoC of each hour can not exceed capacity limits
		// SoC =  previous hour SoC
		//	+ (chargeTimeThisHour) * (chargePower * chargeEff) => efficiency reduces kWh going in of battery
		//	- (dischargeTimeThisHour) * (dischargePower) => efficiency is already on DC side
		const SoC = {
			name: `SoC${hourIdx}`,
			vars: [
				{ name: 'startSoC', coef: 1 },
			],
			bnds: { type: glpk.GLP_DB, ub: maxSoC, lb: minSoC },
		};
		for (let hIdx = 0; hIdx <= hourIdx; hIdx += 1) {
			[...chargeSpeeds].forEach((speed, csIdx) => {
				SoC.vars.push({ name: `cs${csIdx}T${hIdx}`, coef: ((speed.power / 1000) * speed.eff) });
			});
			[...dischargeSpeeds].forEach((speed, dsIdx) => {
				SoC.vars.push({ name: `ds${dsIdx}T${hIdx}`, coef: -(speed.power / 1000) });
			});
		}
		model.subjectTo.push(SoC);

		// build bounds
		// charge / discharge time can not exceed 1 hour per hour
		[...chargeSpeeds].forEach((speed, csIdx) => {
			const timeBound = {
				name: `cs${csIdx}T${hourIdx}`,
				type: glpk.GLP_DB,
				ub: 1,
				lb: 0,
			};
			model.bounds.push(timeBound);
		});
		[...dischargeSpeeds].forEach((speed, dsIdx) => {
			const timeBound = {
				name: `ds${dsIdx}T${hourIdx}`,
				type: glpk.GLP_DB,
				ub: 1,
				lb: 0,
			};
			model.bounds.push(timeBound);
		});

	});

	// add start conditions
	const startBound = {
		name: 'startSoC',
		type: glpk.GLP_FX,
		ub: startSoC,
		lb: startSoC,
	};
	model.bounds.push(startBound);

	// add end SoC cost
	// -SoC (kWh) * average price
	// const avgPrice = [...prices].reduce((a, b) => (a + b)) / prices.length;
	// const endSoCValue = { name: 'endSoC', coef: -avgPrice };
	// model.objective.vars.push(endSoCValue);

	// console.dir(model, { depth: null });
	const solved = glpk.solve(model, modelOptions);
	// console.dir(solved, { depth: null });

	// Create summarized strategy output.
	const strategy = {};
	let storedEnergy = startSoC;
	[...prices].forEach((price, hourIdx) => {
		const stratResultKeys = Object.keys(solved.result.vars)
			.filter((key) => key.split('T').pop() === `${hourIdx}`); // select currentHour strategy only
		let totalTime = 0;
		let avgPower = 0;
		const socAtStart = storedEnergy;
		stratResultKeys.forEach((stratKey) => {
			if (stratKey.includes('cs') && solved.result.vars[stratKey] > 0) {	// is a charging factor
				const chrgIndex = stratKey[2]; // third character of key name
				const chrgTime = solved.result.vars[stratKey];
				const chrgPower = chargeSpeeds[chrgIndex].power / 1000;
				totalTime += chrgTime;
				avgPower -= chrgTime * chrgPower; // charging power is negative
				storedEnergy += chrgTime * chrgPower * chargeSpeeds[chrgIndex].eff;
			}
			if (stratKey.includes('ds') && solved.result.vars[stratKey] > 0) {	// is a discharging factor
				const dchrgIndex = stratKey[2]; // third character of key name
				const dchrgTime = solved.result.vars[stratKey];
				const dchrgPower = dischargeSpeeds[dchrgIndex].power / 1000;
				totalTime += dchrgTime;
				avgPower += dchrgTime * dchrgPower;
				storedEnergy -= dchrgTime * dchrgPower;
			}
		});
		// summarize for this hour
		let power = totalTime > 0 ? Math.round((avgPower * 1000) / totalTime) : 0;
		let duration = Math.round(totalTime * 60);
		let SoCh = Math.abs(Math.round(100 * (storedEnergy / batCapacity)));

		// remove short breaks and operations
		if (cleanUpStrategy) {
			if (((duration < 10) && (power < 0) && (SoCh < 95)) 			// remove short charges, unless almost full
				|| ((duration < 10) && (power > 0) && (SoCh > 5))) {		// remove short discharges, unless almost empty
				power = 0;
				duration = 0;
				storedEnergy = socAtStart;
				SoCh = Math.abs(Math.round(100 * (storedEnergy / batCapacity)));
			}
			if (((duration < 60) && (duration > 55) && (power < 0) && (SoCh > 95)) 			// remove short charging breaks when almost full
				|| ((duration < 60) && (duration > 55) && (power > 0) && (SoCh < 5))) {		// remove short discharging breaks when almost empty
				duration = 60;
				storedEnergy = socAtStart;
				storedEnergy -= power / 1000; // efficiency is not taken into account during charging
				SoCh = Math.abs(Math.round(100 * (storedEnergy / batCapacity)));
			}
		}

		strategy[hourIdx] = {
			power, duration, soc: SoCh, price,
		};
	});

	// compatibility with old hedge_strategy sell = >0 | hold = 0 | buy = <0
	// return strategy[0].power;

	// console.log(strategy);
	return strategy;

};

module.exports = {
	getStrategy,
};

// TEST
// const prices = [0.25, 0.32, 0.429, 0.32, 0.429];
// const prices = [0.25, 0.331, 0.32, 0.322, 0.32, 0.328, 0.339, 0.429, 0.331, 0.32, 0.322, 0.32, 0.328, 0.339, 0.429];
// const prices = [0.16, 0.17, 0.16, 0.13, 0.12, 0.12, 0.12, 0.12, 0.11, 0.11, 0.12, 0.15, 0.16, 0.16, 0.12, 0.10, 0.07, 0.04, 0.02, 0.01, 0.01, 0.06, 0.08, 0.11, 0.16, 0.17, 0.17, 0.17, 0.16];
// const prices = [0.29, 0.28, 0.27, 0.27, 0.27, 0.29, 0.30, 0.33, 0.32, 0.28, 0.27, 0.21, 0.22, 0.22, 0.21, 0.23, 0.25, 0.27, 0.29, 0.29, 0.30, 0.29, 0.28, 0.27];
// const prices = [
// 	0.4854, 0.2918, 0.2885,
// 	0.2841,
// 	0.2856, 0.2937, 0.325, 0.3515,
// 	0.3459, 0.3206, 0.2977, 0.2833,
// 	0.2699, 0.261728, 0.2611956,
// 	0.2697382, 0.2958379,
// 	0.3299599, 0.4283329,
// 	0.4895831, 0.5087132,
// 	0.44683379999999995, 0.3645901,
// 	0.3232686,

//   0.31740009999999996,
// 	0.30666740000000003, 0.2983184,
// 	0.28619419999999995, 0.2718799,
// 	0.2704279, 0.2886989,
// 	0.32415190000000005, 0.3211632,
// 	0.3151616, 0.2767199,
// 	0.2807613, 0.2765747,
// 	0.2787164, 0.2905139,
// 	0.2961646, 0.3052517,
// 	0.3467426, 0.41173170000000003,
// 	0.4762005, 0.45746970000000003,
// 	0.38278850000000003, 0.3484245,
// 	0.3130078,
// ];

// console.dir(getStrategy({ prices, soc: 50, startMinute: 25 }), { depth: null });

/*
{
  '0': { power: 1700, duration: 35, soc: 30, price: 0.4854 },
  '1': { power: 0, duration: 0, soc: 30, price: 0.2918 },
  '2': { power: 0, duration: 0, soc: 30, price: 0.2885 },
  '3': { power: 0, duration: 0, soc: 30, price: 0.2841 },
  '4': { power: 0, duration: 0, soc: 30, price: 0.2856 },
  '5': { power: 0, duration: 0, soc: 30, price: 0.2937 },
  '6': { power: 0, duration: 0, soc: 30, price: 0.325 },
  '7': { power: 0, duration: 0, soc: 30, price: 0.3515 },
  '8': { power: 0, duration: 0, soc: 30, price: 0.3459 },
  '9': { power: 0, duration: 0, soc: 30, price: 0.3206 },
  '10': { power: 0, duration: 0, soc: 30, price: 0.2977 },
  '11': { power: 0, duration: 0, soc: 30, price: 0.2833 },
  '12': { power: -1050, duration: 32, soc: 41, price: 0.2699 },
  '13': { power: -1050, duration: 60, soc: 60, price: 0.261728 },
  '14': { power: -1050, duration: 60, soc: 80, price: 0.2611956 },
  '15': { power: -1050, duration: 60, soc: 100, price: 0.2697382 },
  '16': { power: 0, duration: 0, soc: 100, price: 0.2958379 },
  '17': { power: 0, duration: 0, soc: 100, price: 0.3299599 },
  '18': { power: 765, duration: 60, soc: 85, price: 0.4283329 },
  '19': { power: 1700, duration: 60, soc: 51, price: 0.4895831 },
  '20': { power: 1700, duration: 60, soc: 18, price: 0.5087132 },
  '21': { power: 885, duration: 60, soc: 0, price: 0.44683379999999995 },
  '22': { power: 0, duration: 0, soc: 0, price: 0.3645901 },
  '23': { power: 0, duration: 0, soc: 0, price: 0.3232686 },
  '24': { power: 0, duration: 0, soc: 0, price: 0.31740009999999996 },
  '25': { power: 0, duration: 0, soc: 0, price: 0.30666740000000003 },
  '26': { power: 0, duration: 0, soc: 0, price: 0.2983184 },
  '27': { power: 0, duration: 0, soc: 0, price: 0.28619419999999995 },
  '28': { power: -1050, duration: 60, soc: 20, price: 0.2718799 },
  '29': { power: -1050, duration: 60, soc: 40, price: 0.2704279 },
  '30': { power: 0, duration: 0, soc: 40, price: 0.2886989 },
  '31': { power: 0, duration: 0, soc: 40, price: 0.32415190000000005 },
  '32': { power: 0, duration: 0, soc: 40, price: 0.3211632 },
  '33': { power: 0, duration: 0, soc: 40, price: 0.3151616 },
  '34': { power: -1050, duration: 60, soc: 59, price: 0.2767199 },
  '35': { power: 0, duration: 0, soc: 59, price: 0.2807613 },
  '36': { power: -1050, duration: 60, soc: 79, price: 0.2765747 },
  '37': { power: -1050, duration: 11, soc: 82, price: 0.2787164 },
  '38': { power: 0, duration: 0, soc: 82, price: 0.2905139 },
  '39': { power: 0, duration: 0, soc: 82, price: 0.2961646 },
  '40': { power: 0, duration: 0, soc: 82, price: 0.3052517 },
  '41': { power: 0, duration: 0, soc: 82, price: 0.3467426 },
  '42': { power: 765, duration: 60, soc: 67, price: 0.41173170000000003 },
  '43': { power: 1700, duration: 60, soc: 34, price: 0.4762005 },
  '44': { power: 1700, duration: 60, soc: 0, price: 0.45746970000000003 },
  '45': { power: 0, duration: 0, soc: 0, price: 0.38278850000000003 },
  '46': { power: 0, duration: 0, soc: 0, price: 0.3484245 },
  '47': { power: 0, duration: 0, soc: 0, price: 0.3130078 }
}
*/
