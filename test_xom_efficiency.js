// Mocking the structure
const collectBatteryInfo = (devices) => devices
  .map((device) => ({
    id: device.id,
    name: device.name,
    maxCharge: device.maxCharge,
    maxDischarge: device.maxDischarge,
    soc: device.soc,
    actualPower: device.actualPower,
    xomTargetPower: 0,
  }));

const calculateStrategyIterative = (batteryInfo, totalTarget, minLoad) => {
  // 1. Sort batteries by priority (SoC)
  // Discharge: Higher SoC = Better. Charge: Lower SoC = Better.
  const sortedInfo = [...batteryInfo];
  if (totalTarget < 0) { // Discharge
    sortedInfo.sort((a, b) => b.soc - a.soc);
  } else { // Charge
    sortedInfo.sort((a, b) => a.soc - b.soc);
  }

  // 2. Iterative loop: Try with N batteries, then N-1, etc.
  // We want the smallest number of batteries that can handle the load efficiently.
  // Actually, we want to start with the BEST subset and expand if needed?
  // Or start with ALL and shrink?
  // Shrinking is safer to find the "Limit".
  
  let selectedIndices = sortedInfo.map((_, i) => i); // Start with all
  let finalStrategy = null;

  // We try to drop the "worst" battery (last in list) iteratively
  for (let i = sortedInfo.length; i > 0; i--) {
    const currentSubset = sortedInfo.slice(0, i);
    
    // Calculate stats for this subset
    const totalSubsetSoc = currentSubset.reduce((sum, b) => sum + b.soc, 0);
    const totalSubsetEmpty = currentSubset.reduce((sum, b) => sum + (100 - b.soc), 0);
    
    // Calculate Proportional Split for this subset
    const attempt = currentSubset.map(info => {
      let fraction = 0;
      if (totalTarget < 0) {
        fraction = (totalSubsetSoc > 0) ? (info.soc / totalSubsetSoc) : 0;
      } else if (totalTarget > 0) {
        fraction = (totalSubsetEmpty > 0) ? ((100 - info.soc) / totalSubsetEmpty) : 0;
      }
      
      let target = totalTarget * fraction;
      
      // Constraints
      let constrained = Math.max(-info.maxDischarge, Math.min(info.maxCharge, target));
      
      // Note: We do NOT apply minLoad clamping here yet, 
      // because we want to see if the raw split fits. 
      // Actually, if it drops below minLoad, it's invalid for this efficiency pass.
      
      return { ...info, target: constrained, rawTarget: target };
    });

    // Check if this subset covers the Total Target (within tolerance)
    const totalAttempted = attempt.reduce((sum, b) => sum + b.target, 0);
    const difference = Math.abs(totalTarget - totalAttempted);
    
    // Check constraints:
    // 1. Must cover the target (limited by max power)
    //    If we drop a battery and can no longer cover the target (clipping), then this subset is too small.
    // 2. All active targets should be > minLoad (soft or hard constraint?)
    //    If we are optimizing, we prefer them to be > minLoad.
    
    const isCoverageGood = difference < 10; // Tolerance
    
    // Optimization check:
    // If we cover the target, this is a VALID strategy.
    // Since we iterate from Many -> Few, the LAST valid strategy we find 
    // is the most "Concentrated" (Fewest batteries).
    // WAIT! If we start from All and remove one by one, the FIRST valid one is "Widest", 
    // the LAST valid one is "Narrowest".
    // We want Narrowest.
    
    if (isCoverageGood) {
      // Map back to full array (inactive ones get 0)
      const strategyMap = new Map(attempt.map(b => [b.id, b]));
      
      const fullStrategy = sortedInfo.map(info => {
        const active = strategyMap.get(info.id);
        if (active) {
            // Recalculate headroom for consistency
            let target = active.target;
             // Apply minLoad here? 
             // If we successfully concentrated, hopefully values are high.
             // If value is still < minLoad, then it will be zeroed later, 
             // implying even 1 battery is too much (Load < MinLoad).
             if (Math.abs(target) < minLoad) target = 0;
             
             let headroom = 0;
             if (totalTarget < 0) headroom = (info.soc > 0) ? (info.maxDischarge + target) : 0;
             if (totalTarget > 0) headroom = (info.soc < 100) ? (info.maxCharge - target) : 0;

            return { ...info, target, headroom, fraction: 0 }; // Fraction placeholder
        } else {
            // Inactive
            let headroom = 0;
            // Headroom for inactive battery? 
            // Technically it has full headroom relative to 0? 
            // Or 0 because it's excluded?
            // To be safe for distributeRemainingPower, we give it 0 target.
            // But if we want distributeRemainingPower to use it as backup...
            // Let's say it has headroom.
             if (totalTarget < 0) headroom = (info.soc > 0) ? info.maxDischarge : 0;
             if (totalTarget > 0) headroom = (info.soc < 100) ? info.maxCharge : 0;
            
            return { ...info, target: 0, headroom, fraction: 0 };
        }
      });
      
      finalStrategy = fullStrategy;
    } else {
        // If we cannot cover the target, we went too far. Stop.
        // The PREVIOUS iteration was the best concentrated one.
        break; 
    }
  }

  return finalStrategy || []; // Should fallback to 'All' if loop breaks immediately?
};

// --- Test Runner ---
const runTest = (name, devices, load, minLoad) => {
    console.log(`
--- ${name} ---
`);
    console.log(`Total Load: ${load}, MinLoad: ${minLoad}`);
    const strategy = calculateStrategyIterative(devices, -load, minLoad);
    
    const totalAssigned = strategy.reduce((s,b) => s + b.target, 0);
    console.log(`Assigned Total: ${totalAssigned.toFixed(2)}`);
    strategy.forEach(b => {
        console.log(`${b.name} (${b.soc}%): Target ${b.target.toFixed(2)}`);
    });
};

// Mock Devices
const devs = [
  { id: 'b1', name: 'Bat1', soc: 80, maxCharge: 2000, maxDischarge: 2000, actualPower: 0 },
  { id: 'b2', name: 'Bat2', soc: 80, maxCharge: 2000, maxDischarge: 2000, actualPower: 0 },
  { id: 'b3', name: 'Bat3', soc: 80, maxCharge: 2000, maxDischarge: 2000, actualPower: 0 },
];

// Test 1: Load 120 (Small). Fits in 1.
runTest('Test 1: Small Load', devs, 120, 50);

// Test 2: Load 2100 (Large). Needs 2.
runTest('Test 2: Medium Load', devs, 2100, 50);

// Test 3: Load 5000 (Huge). Needs 3 (Clips at 6000).
runTest('Test 3: Huge Load', devs, 5000, 50);

// Test 4: SoC Bias.
const devsSoc = [
  { id: 'b1', name: 'Bat1', soc: 90, maxCharge: 2000, maxDischarge: 2000, actualPower: 0 },
  { id: 'b2', name: 'Bat2', soc: 50, maxCharge: 2000, maxDischarge: 2000, actualPower: 0 },
  { id: 'b3', name: 'Bat3', soc: 20, maxCharge: 2000, maxDischarge: 2000, actualPower: 0 },
];
// Load 1000. Fits in 1. Should pick Bat1 (90%).
runTest('Test 4: SoC Bias (Load 1000)', devsSoc, 1000, 50);

// Load 3000. Needs 2. Should pick Bat1 + Bat2.
runTest('Test 5: SoC Bias (Load 3000)', devsSoc, 3000, 50);

