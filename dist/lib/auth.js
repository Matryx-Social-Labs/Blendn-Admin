"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAuth = exports.authOptions = void 0;
const prisma_adapter_1 = require("@auth/prisma-adapter");
const next_auth_1 = require("next-auth");
const credentials_1 = __importDefault(require("next-auth/providers/credentials"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const db_1 = require("./db");
exports.authOptions = {
    adapter: (0, prisma_adapter_1.PrismaAdapter)(db_1.db),
    session: { strategy: "jwt" },
    pages: {
        signIn: "/login",
    },
    providers: [
        (0, credentials_1.default)({
            name: "credentials",
            credentials: {
                email: { label: "Email", type: "email" },
                password: { label: "Password", type: "password" },
            },
            async authorize(credentials) {
                if (!(credentials === null || credentials === void 0 ? void 0 : credentials.email) || !(credentials === null || credentials === void 0 ? void 0 : credentials.password)) {
                    return null;
                }
                const user = await db_1.db.user.findUnique({
                    where: { email: credentials.email },
                });
                if (!user || !user.password) {
                    return null;
                }
                const isValid = await bcryptjs_1.default.compare(credentials.password, user.password);
                if (!isValid) {
                    return null;
                }
                return { id: user.id, email: user.email, name: user.name };
            },
        }),
    ],
    callbacks: {
        async session({ session, token }) {
            if (token && session.user) {
                session.user.id = token.sub;
            }
            return session;
        },
        async jwt({ token, user }) {
            if (user) {
                token.sub = user.id;
            }
            return token;
        },
    },
};
const getAuth = () => (0, next_auth_1.getServerSession)(exports.authOptions);
exports.getAuth = getAuth;
