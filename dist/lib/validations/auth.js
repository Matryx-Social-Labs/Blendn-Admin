"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.refreshTokenSchema = exports.signinSchema = exports.signupSchema = void 0;
const zod_1 = require("zod");
exports.signupSchema = zod_1.z.object({
    email: zod_1.z.string().email("Invalid email address"),
    password: zod_1.z
        .string()
        .min(8, "Password must be at least 8 characters")
        .max(100, "Password must be at most 100 characters"),
    name: zod_1.z.string().min(1, "Name is required").max(100, "Name is too long").optional(),
    deviceInfo: zod_1.z
        .object({
        platform: zod_1.z.string().optional(),
        device: zod_1.z.string().optional(),
        appVersion: zod_1.z.string().optional(),
    })
        .optional(),
});
exports.signinSchema = zod_1.z.object({
    email: zod_1.z.string().email("Invalid email address"),
    password: zod_1.z.string().min(1, "Password is required"),
    deviceInfo: zod_1.z
        .object({
        platform: zod_1.z.string().optional(),
        device: zod_1.z.string().optional(),
        appVersion: zod_1.z.string().optional(),
    })
        .optional(),
});
exports.refreshTokenSchema = zod_1.z.object({
    refreshToken: zod_1.z.string().min(1, "Refresh token is required"),
});
