"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ratingSchema = exports.checkinSchema = exports.eventQuerySchema = void 0;
const zod_1 = require("zod");
exports.eventQuerySchema = zod_1.z.object({
    // Pagination
    page: zod_1.z.coerce.number().int().min(1).default(1),
    limit: zod_1.z.coerce.number().int().min(1).max(100).default(20),
    // Search
    search: zod_1.z.string().optional(),
    // Nearby filter
    lat: zod_1.z.coerce.number().min(-90).max(90).optional(),
    lon: zod_1.z.coerce.number().min(-180).max(180).optional(),
    radius: zod_1.z.coerce.number().min(0.1).max(100).default(10), // km
    // Category filter
    categoryId: zod_1.z.string().uuid().optional(),
    categorySlug: zod_1.z.string().optional(),
    // Date filters
    startDate: zod_1.z.string().datetime().optional(),
    endDate: zod_1.z.string().datetime().optional(),
    // Status filter
    status: zod_1.z.enum(["draft", "published", "cancelled", "completed"]).optional(),
    // Sort
    sortBy: zod_1.z.enum(["start_time", "created_at", "distance"]).default("start_time"),
    sortOrder: zod_1.z.enum(["asc", "desc"]).default("asc"),
    // Optional includes (comma-separated list)
    include: zod_1.z.string().optional(),
    // Interested preview limit (used when include contains interestedPreview)
    interestedPreviewLimit: zod_1.z.coerce.number().int().min(1).max(6).optional(),
});
exports.checkinSchema = zod_1.z.object({
    latitude: zod_1.z.number().min(-90).max(90),
    longitude: zod_1.z.number().min(-180).max(180),
    deviceInfo: zod_1.z
        .object({
        platform: zod_1.z.string().optional(),
        device: zod_1.z.string().optional(),
        appVersion: zod_1.z.string().optional(),
    })
        .optional(),
});
exports.ratingSchema = zod_1.z.object({
    rating: zod_1.z.number().int().min(1).max(5),
    review: zod_1.z.string().max(1000).optional(),
});
