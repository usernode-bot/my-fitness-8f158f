'use strict';

// The health math behind My Fitness. Every route that serves or stores a
// plan goes through this module, so the numbers a user sees are computed
// exactly once, in one place, on the server.
//
// Formulas are pinned here on purpose; the frontend only mirrors them for
// the wizard's preview step, and the server's values are the authoritative
// ones returned after save.

const GENDERS = ['male', 'female', 'other'];
const ACTIVITY_LEVELS = ['sedentary', 'light', 'moderate', 'active', 'very_active'];
const GOAL_TYPES = ['lose', 'maintain', 'gain'];

// Mifflin-St Jeor activity multipliers, by activity level.
const ACTIVITY_FACTORS = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
};

// Goal-adjusted macro splits, percent protein / carbs / fat.
const MACRO_SPLITS = {
  lose: { protein: 40, carbs: 30, fat: 30 },
  maintain: { protein: 30, carbs: 40, fat: 30 },
  gain: { protein: 30, carbs: 45, fat: 25 },
};

const KCAL_PER_GRAM = { protein: 4, carbs: 4, fat: 9 };

// Never prescribe below this many calories per day.
const CALORIE_FLOOR = 1200;

// Water: roughly 35 ml per kg of body weight, clamped to a sane band.
const WATER_ML_PER_KG = 35;
const WATER_MIN_ML = 1500;
const WATER_MAX_ML = 4000;
const GLASS_ML = 250;

// Acceptable input ranges, shared by the API validator and the wizard copy.
const LIMITS = {
  age: { min: 13, max: 100 },
  heightCm: { min: 100, max: 250 },
  weightKg: { min: 30, max: 300 },
};

function roundTo(value, step) {
  return Math.round(value / step) * step;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function bmiCategory(bmi) {
  if (bmi < 18.5) return 'Underweight';
  if (bmi < 25) return 'Healthy';
  if (bmi < 30) return 'Overweight';
  return 'Obese';
}

// profile: { weight_kg, height_cm, age, gender, activity_level }
// goal:    { goal_type, target_weight_kg, target_date }
function computeTargets(profile, goal) {
  const kg = Number(profile.weight_kg);
  const cm = Number(profile.height_cm);
  const age = Number(profile.age);
  const heightM = cm / 100;

  const bmi = round1(kg / (heightM * heightM));

  const genderOffset = profile.gender === 'male' ? 5 : profile.gender === 'female' ? -161 : -78;
  const bmr = 10 * kg + 6.25 * cm - 5 * age + genderOffset;

  const tdee = bmr * ACTIVITY_FACTORS[profile.activity_level];

  let calorieTarget;
  if (goal.goal_type === 'lose') calorieTarget = tdee - 500;
  else if (goal.goal_type === 'gain') calorieTarget = tdee + 300;
  else calorieTarget = tdee;
  const calorieFloorApplied = calorieTarget < CALORIE_FLOOR;
  calorieTarget = Math.max(CALORIE_FLOOR, roundTo(calorieTarget, 10));

  const split = MACRO_SPLITS[goal.goal_type];
  const proteinGrams = Math.round((calorieTarget * split.protein / 100) / KCAL_PER_GRAM.protein);
  const carbsGrams = Math.round((calorieTarget * split.carbs / 100) / KCAL_PER_GRAM.carbs);
  const fatGrams = Math.round((calorieTarget * split.fat / 100) / KCAL_PER_GRAM.fat);

  const waterTargetMl = Math.min(
    WATER_MAX_ML,
    Math.max(WATER_MIN_ML, roundTo(kg * WATER_ML_PER_KG, 100))
  );

  return {
    bmi,
    bmiCategory: bmiCategory(bmi),
    bmr: Math.round(bmr),
    tdee: Math.round(tdee),
    calorieTarget,
    calorieFloorApplied,
    proteinGrams,
    carbsGrams,
    fatGrams,
    macroSplit: split,
    waterTargetMl,
    glassMl: GLASS_ML,
  };
}

// Returns { value } when the payload is acceptable, or { errors } keyed by
// field. Used by POST /api/profile; the wizard mirrors the same rules.
function validateProfilePayload(body) {
  const errors = {};
  const value = {};

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) errors.name = 'Enter your name';
  else if (name.length > 100) errors.name = 'Name must be 100 characters or fewer';
  else value.name = name;

  const age = Number(body.age);
  if (!Number.isInteger(age) || age < LIMITS.age.min || age > LIMITS.age.max) {
    errors.age = 'Enter an age between ' + LIMITS.age.min + ' and ' + LIMITS.age.max;
  } else value.age = age;

  if (!GENDERS.includes(body.gender)) errors.gender = 'Choose a gender';
  else value.gender = body.gender;

  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (email) {
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.email = 'Enter a valid email address';
    } else value.email = email;
  } else value.email = null;

  const heightCm = Number(body.height_cm);
  if (!Number.isFinite(heightCm) || heightCm < LIMITS.heightCm.min || heightCm > LIMITS.heightCm.max) {
    errors.height_cm = 'Enter a height between ' + LIMITS.heightCm.min + ' and ' + LIMITS.heightCm.max + ' cm';
  } else value.height_cm = heightCm;

  const weightKg = Number(body.weight_kg);
  if (!Number.isFinite(weightKg) || weightKg < LIMITS.weightKg.min || weightKg > LIMITS.weightKg.max) {
    errors.weight_kg = 'Enter a weight between ' + LIMITS.weightKg.min + ' and ' + LIMITS.weightKg.max + ' kg';
  } else value.weight_kg = weightKg;

  if (!ACTIVITY_LEVELS.includes(body.activity_level)) errors.activity_level = 'Choose an activity level';
  else value.activity_level = body.activity_level;

  if (!GOAL_TYPES.includes(body.goal_type)) errors.goal_type = 'Choose a goal';
  else value.goal_type = body.goal_type;

  const needsTarget = body.goal_type === 'lose' || body.goal_type === 'gain';
  const targetWeight = Number(body.target_weight_kg);
  if (needsTarget) {
    if (!Number.isFinite(targetWeight) || targetWeight < LIMITS.weightKg.min || targetWeight > LIMITS.weightKg.max) {
      errors.target_weight_kg = 'Enter a target weight between ' + LIMITS.weightKg.min + ' and ' + LIMITS.weightKg.max + ' kg';
    } else value.target_weight_kg = targetWeight;
  } else value.target_weight_kg = null;

  if (needsTarget) {
    const raw = typeof body.target_date === 'string' ? body.target_date : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      errors.target_date = 'Choose a target date';
    } else {
      const d = new Date(raw + 'T00:00:00');
      const tomorrow = new Date();
      tomorrow.setHours(0, 0, 0, 0);
      tomorrow.setDate(tomorrow.getDate() + 1);
      if (Number.isNaN(d.getTime()) || d < tomorrow) {
        errors.target_date = 'Choose a date in the future';
      } else value.target_date = raw;
    }
  } else value.target_date = null;

  if (Object.keys(errors).length) return { errors };
  return { value };
}

module.exports = {
  GENDERS,
  ACTIVITY_LEVELS,
  GOAL_TYPES,
  ACTIVITY_FACTORS,
  MACRO_SPLITS,
  LIMITS,
  CALORIE_FLOOR,
  GLASS_ML,
  computeTargets,
  validateProfilePayload,
};
