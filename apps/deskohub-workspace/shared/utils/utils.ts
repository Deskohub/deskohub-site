import { type ClassValue, clsx } from "clsx";
import { Predicate } from "effect";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Whether a value is one `cn` takes as a class value: a string, number,
 * bigint, boolean, nullish, a class dictionary, or an array of these.
 */
export function isClassValue<Value>(value: Value): value is Value & ClassValue {
  return (
    Predicate.isString(value) ||
    Predicate.isNumber(value) ||
    Predicate.isBigInt(value) ||
    Predicate.isBoolean(value) ||
    Predicate.isNullish(value) ||
    Predicate.isObject(value) ||
    (Array.isArray(value) && value.every(isClassValue))
  );
}
