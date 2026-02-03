"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.successResponse = successResponse;
exports.errorResponse = errorResponse;
exports.validationErrorResponse = validationErrorResponse;
exports.unauthorizedResponse = unauthorizedResponse;
exports.forbiddenResponse = forbiddenResponse;
exports.notFoundResponse = notFoundResponse;
exports.serverErrorResponse = serverErrorResponse;
exports.conflictResponse = conflictResponse;
const server_1 = require("next/server");
/**
 * Create a success response
 */
function successResponse(data, status = 200) {
    return server_1.NextResponse.json({
        success: true,
        data,
    }, { status });
}
/**
 * Create an error response
 */
function errorResponse(message, status = 400) {
    return server_1.NextResponse.json({
        success: false,
        error: message,
    }, { status });
}
/**
 * Create a validation error response from Zod errors
 */
function validationErrorResponse(error) {
    const errors = error.errors.map((e) => ({
        field: e.path.join("."),
        message: e.message,
    }));
    return server_1.NextResponse.json({
        success: false,
        error: "Validation failed",
        errors,
    }, { status: 400 });
}
/**
 * Create an unauthorized response
 */
function unauthorizedResponse(message = "Unauthorized") {
    return server_1.NextResponse.json({
        success: false,
        error: message,
    }, { status: 401 });
}
/**
 * Create a forbidden response
 */
function forbiddenResponse(message = "Forbidden") {
    return server_1.NextResponse.json({
        success: false,
        error: message,
    }, { status: 403 });
}
/**
 * Create a not found response
 */
function notFoundResponse(message = "Not found") {
    return server_1.NextResponse.json({
        success: false,
        error: message,
    }, { status: 404 });
}
/**
 * Create a server error response
 */
function serverErrorResponse(message = "Internal server error") {
    return server_1.NextResponse.json({
        success: false,
        error: message,
    }, { status: 500 });
}
/**
 * Create a conflict response (e.g., duplicate resource)
 */
function conflictResponse(message = "Resource already exists") {
    return server_1.NextResponse.json({
        success: false,
        error: message,
    }, { status: 409 });
}
