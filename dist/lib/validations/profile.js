"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.removeInterestsSchema = exports.addInterestsSchema = exports.updateProfileSchema = void 0;
const zod_1 = require("zod");
exports.updateProfileSchema = zod_1.z.object({
    name: zod_1.z.string().min(1).max(100).optional(),
    phone: zod_1.z.string().max(20).optional().nullable(),
    age: zod_1.z.number().int().min(13).max(120).optional().nullable(),
    location: zod_1.z.string().max(200).optional().nullable(),
    interests: zod_1.z.array(zod_1.z.string()).optional(),
    onboarded: zod_1.z.boolean().optional(),
});
exports.addInterestsSchema = zod_1.z.object({
    categoryIds: zod_1.z.array(zod_1.z.string().uuid("Invalid category ID")).min(1, "At least one category is required"),
});
exports.removeInterestsSchema = zod_1.z.object({
    categoryIds: zod_1.z.array(zod_1.z.string().uuid("Invalid category ID")).min(1, "At least one category is required"),
});
