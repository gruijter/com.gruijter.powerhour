/*
Copyright 2019 - 2023, Robin de Gruijter (gruijter@hotmail.com)

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

// returns the best trading strategy for the first hour	// sell = 1 | hold = 0 | buy = -1
const getStrategy = ({
	prices,	// array of hourly prices, e.g. [0.331, 0.32, 0.322, 0.32, 0.328, 0.339, 0.429, 0.331, 0.32, 0.322, 0.32, 0.328, 0.339, 0.429];
	minPriceDelta = 0.1,	// mimimum price difference from highest or lowest price to sell/buy
	soc = 0,	// Battery State of Charge at start of first hour
	batCapacity = 5.05, // in kWh
	chargePower = 2000, // in Watt
	dischargePower = 1700, // in Watt
}) => {
	// calculate charge speeds as percentage per hour
	const chargeSpeed = chargePower / (batCapacity * 10); // % per hour
	const dischargeSpeed = dischargePower / (batCapacity * 10); // % per hour

	// calculate min/max/avg prices of all given prices
	const avgPrice = prices.reduce((a, b) => (a + b)) / prices.length;
	const maxPrice = Math.max(...prices);
	const minPrice = Math.min(...prices);
	// limit search to the first 10 peaks/troughs
	const peakPrices = prices
		.filter((price) => (price - minPrice) > minPriceDelta * 0.7 || (maxPrice - price) > minPriceDelta)
		.slice(0, 10);
	if (peakPrices[0] !== prices[0]) return 0; // return Hold strategy if first hour is not a peak price

	const startState = {
		profit: 0,
		prices: peakPrices,
		soc,
		hourlyStrat: [],
	};
	const allResults = [];
	const stateAfter = (stateBefore) => {
		const price = stateBefore.prices.shift();
		const strat = [0]; // standard strategy = hold;
		if ((price - minPrice) > minPriceDelta) strat.push(1); // add sell strategy
		if ((maxPrice - price) > minPriceDelta) strat.push(-1); // add buy strategy
		// run all 3 strategies
		strat.forEach((strategy) => {
			if (price === undefined) return null;
			let afterState = { ...stateBefore };
			afterState.prices = [...stateBefore.prices];
			afterState.hourlyStrat = [...stateBefore.hourlyStrat];
			// sell
			if (strategy > 0 && afterState.soc > 0)	{ // can only sell when there is enough charge
				const sellingPercent = afterState.soc < dischargeSpeed ? afterState.soc : dischargeSpeed;
				afterState.profit += (sellingPercent / 100) * batCapacity * price;
				afterState.soc -= sellingPercent;
			}
			// buy
			if (strategy < 0 && afterState.soc < 100)	{	// can only buy when batt is not full
				const buyingPercent = chargeSpeed > (100 - afterState.soc) ? (100 - afterState.soc) : chargeSpeed;
				afterState.profit -= (buyingPercent / 100) * batCapacity * price;
				afterState.soc += buyingPercent;
			}
			// hold
			// if (strategy === 0) { } // do nothing
			afterState.hourlyStrat.push({ [price]: strategy, soc: afterState.soc, profit: afterState.profit });
			afterState = stateAfter(afterState);
			return afterState;
		});
		// all possible outcomes are recursively handled
		if (price === undefined) {
			const finished = JSON.parse(JSON.stringify(stateBefore));
			// add value of soc
			finished.socValue = (finished.soc / 100) * batCapacity * avgPrice; // value the soc against avg price
			allResults.push(finished);
		}
	};

	stateAfter(startState);
	const sorted = allResults.sort((a, b) => (b.profit + b.socValue) - (a.profit + a.socValue));
	// console.dir(sorted, { depth: null });
	// console.log('best strat:', sorted[0]);
	return sorted[0].hourlyStrat[0][prices[0]];
};

// TEST
// const prices = [0.331, 0.32, 0.322, 0.32, 0.328, 0.339, 0.429, 0.331, 0.32, 0.322, 0.32, 0.328, 0.339, 0.429];
// console.dir(getStrategy({ prices, soc: 50 }), { depth: null });

module.exports = {
	getStrategy,
};
