const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const jwt = require("jsonwebtoken");
require("dotenv").config();

const app = express();

// ===============================
// تنظیمات Express
// ===============================

// چون تصاویر به صورت Base64 ارسال می‌شوند
// باید محدودیت حجم درخواست افزایش پیدا کند.
app.use(express.json({ limit: "30mb" }));

app.use(
    express.urlencoded({
        extended: true,
        limit: "30mb"
    })
);

app.use(cors());

// ===============================
// اتصال PostgreSQL
// ===============================

const pool = new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD
});

const PORT = Number(process.env.PORT) || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

// بررسی JWT_SECRET
if (!JWT_SECRET) {
    console.error("ERROR: JWT_SECRET environment variable is missing.");
    process.exit(1);
}

// ===============================
// حافظه موقت OTP
// ===============================

const otpStore = new Map();

// ===============================
// تست دیتابیس
// ===============================

app.get("/api/test-db", async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT NOW() AS time"
        );

        res.json({
            success: true,
            message: "اتصال به PostgreSQL موفق بود",
            database: process.env.DB_NAME,
            time: result.rows[0].time
        });

    } catch (error) {
        console.error("Database test error:", error);

        res.status(500).json({
            success: false,
            message: "اتصال به PostgreSQL ناموفق بود"
        });
    }
});

// ===============================
// تست سرور
// ===============================

app.get("/api/test", (req, res) => {
    res.json({
        success: true,
        message: "Backend is running"
    });
});

// ===============================
// نرمال‌سازی شماره موبایل
// ===============================

function normalizePhone(phone) {

    if (!phone) {
        return null;
    }

    let value = String(phone).trim();

    // تبدیل اعداد فارسی به انگلیسی
    value = value.replace(
        /[۰-۹]/g,
        d => "۰۱۲۳۴۵۶۷۸۹".indexOf(d)
    );

    // تبدیل اعداد عربی به انگلیسی
    value = value.replace(
        /[٠-٩]/g,
        d => "٠١٢٣٤٥٦٧٨٩".indexOf(d)
    );

    // حذف فاصله
    value = value.replace(/\s+/g, "");

    // +98xxxxxxxxxx
    if (value.startsWith("+98")) {
        value = value.substring(3);
    }

    // 0098xxxxxxxxxx
    if (value.startsWith("0098")) {
        value = value.substring(4);
    }

    // 98xxxxxxxxxx
    if (
        value.startsWith("98") &&
        value.length === 12
    ) {
        value = value.substring(2);
    }

    // 09xxxxxxxxxx
    if (value.startsWith("0")) {
        value = value.substring(1);
    }

    // باید دقیقاً 9xxxxxxxxx باشد
    if (!/^9\d{9}$/.test(value)) {
        return null;
    }

    return value;
}

// ===============================
// ایجاد / پیدا کردن کاربر
// ===============================

async function findOrCreateUser(phone) {

    const normalizedPhone = normalizePhone(phone);

    if (!normalizedPhone) {
        throw new Error("شماره موبایل نامعتبر است");
    }

    const existing = await pool.query(
        `SELECT
            id,
            phone,
            name,
            family_name,
            email,
            created_at
         FROM users
         WHERE phone = $1`,
        [normalizedPhone]
    );

    if (existing.rows.length > 0) {
        return existing.rows[0];
    }

    const created = await pool.query(
        `INSERT INTO users (
            phone
         )
         VALUES ($1)
         RETURNING
            id,
            phone,
            name,
            family_name,
            email,
            created_at`,
        [normalizedPhone]
    );

    return created.rows[0];
}

// ===============================
// درخواست OTP
// ===============================

app.post("/api/auth/request", async (req, res) => {

    try {

        const phone = normalizePhone(
            req.body.phone
        );

        if (!phone) {

            return res.status(400).json({
                success: false,
                message: "شماره موبایل معتبر نیست"
            });
        }

        // ایجاد یا پیدا کردن حساب مربوط به همین شماره
        const user = await findOrCreateUser(phone);

        // تولید کد ۶ رقمی
        const code = String(
            Math.floor(
                100000 +
                Math.random() * 900000
            )
        );

        // ذخیره موقت OTP
        otpStore.set(phone, {
            code: code,
            expiresAt: Date.now() + 2 * 60 * 1000,
            attempts: 0
        });

        console.log("");
        console.log("================================");
        console.log("OTP CODE");
        console.log("Phone:", phone);
        console.log("Code :", code);
        console.log("User :", user.id);
        console.log("================================");
        console.log("");

        // حالت توسعه
        res.json({
            success: true,
            message: "کد تأیید ایجاد شد",
            userId: user.id,
            phone: phone,
            devCode: code
        });

    } catch (error) {

        console.error(
            "OTP request error:",
            error
        );

        res.status(500).json({
            success: false,
            message: "خطا در ایجاد کد تأیید"
        });
    }
});

// ===============================
// تأیید OTP
// ===============================

app.post("/api/auth/verify", async (req, res) => {

    try {

        const phone = normalizePhone(
            req.body.phone
        );

        const code = String(
            req.body.code || ""
        ).trim();

        if (!phone) {

            return res.status(400).json({
                success: false,
                message: "شماره موبایل نامعتبر است"
            });
        }

        if (!/^\d{6}$/.test(code)) {

            return res.status(400).json({
                success: false,
                message: "کد تأیید باید ۶ رقمی باشد"
            });
        }

        const savedOtp = otpStore.get(phone);

        if (!savedOtp) {

            return res.status(400).json({
                success: false,
                message:
                    "کد تأیید پیدا نشد یا منقضی شده است"
            });
        }

        if (
            Date.now() >
            savedOtp.expiresAt
        ) {

            otpStore.delete(phone);

            return res.status(400).json({
                success: false,
                message: "کد تأیید منقضی شده است"
            });
        }

        savedOtp.attempts++;

        if (savedOtp.attempts > 5) {

            otpStore.delete(phone);

            return res.status(429).json({
                success: false,
                message:
                    "تعداد تلاش بیش از حد مجاز است"
            });
        }

        if (code !== savedOtp.code) {

            return res.status(400).json({
                success: false,
                message: "کد تأیید اشتباه است"
            });
        }

        // پیدا کردن حساب دقیق همین شماره
        const user = await findOrCreateUser(phone);

        // حذف OTP پس از استفاده
        otpStore.delete(phone);

        // ساخت JWT
        const token = jwt.sign(
            {
                userId: user.id,
                phone: user.phone
            },
            JWT_SECRET,
            {
                expiresIn: "7d"
            }
        );

        res.json({
            success: true,
            message: "ورود موفق بود",

            token,

            user: {
                id: user.id,
                phone: user.phone,
                name: user.name,
                familyName: user.family_name,
                email: user.email
            }
        });

    } catch (error) {

        console.error(
            "OTP verify error:",
            error
        );

        res.status(500).json({
            success: false,
            message: "خطا در تأیید کد"
        });
    }
});

// ===============================
// Middleware احراز هویت
// ===============================

function authenticate(req, res, next) {

    try {

        const authHeader =
            req.headers.authorization;

        if (
            !authHeader ||
            !authHeader.startsWith("Bearer ")
        ) {

            return res.status(401).json({
                success: false,
                message: "ورود لازم است"
            });
        }

        const token =
            authHeader.substring(7);

        const decoded =
            jwt.verify(
                token,
                JWT_SECRET
            );

        req.user = decoded;

        next();

    } catch (error) {

        return res.status(401).json({
            success: false,
            message: "نشست کاربر معتبر نیست"
        });
    }
}

// ===============================
// اطلاعات کاربر فعلی
// ===============================

app.get(
    "/api/me",
    authenticate,
    async (req, res) => {

        try {

            const result =
                await pool.query(
                    `SELECT
                        id,
                        phone,
                        name,
                        family_name,
                        email,
                        created_at
                     FROM users
                     WHERE id = $1`,
                    [req.user.userId]
                );

            if (
                result.rows.length === 0
            ) {

                return res.status(404).json({
                    success: false,
                    message: "کاربر پیدا نشد"
                });
            }

            res.json({
                success: true,
                user: result.rows[0]
            });

        } catch (error) {

            console.error(
                "ME error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "خطا در دریافت اطلاعات کاربر"
            });
        }
    }
);

// ===============================
// آگهی‌های کاربر فعلی
// ===============================

app.get(
    "/api/my-ads",
    authenticate,
    async (req, res) => {

        try {

            const result =
                await pool.query(
                    `SELECT *
                     FROM ads
                     WHERE user_id = $1
                     ORDER BY created_at DESC`,
                    [req.user.userId]
                );

            res.json({
                success: true,
                ads: result.rows
            });

        } catch (error) {

            console.error(
                "My ads error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "خطا در دریافت آگهی‌ها"
            });
        }
    }
);

// ===============================
// ثبت آگهی
// ===============================

app.post(
    "/api/ads",
    authenticate,
    async (req, res) => {

        try {

            const {
                category,
                subcategory,
                title,
                description,
                condition,
                price,
                region,
                village,
                location,
                sellerName,
                sellerEmail,
                images
            } = req.body;

            // ===========================
            // اعتبارسنجی اصلی
            // ===========================

            if (
                !category ||
                !String(category).trim()
            ) {

                return res.status(400).json({
                    success: false,
                    message:
                        "دسته‌بندی آگهی الزامی است"
                });
            }

            if (
                !title ||
                !String(title).trim()
            ) {

                return res.status(400).json({
                    success: false,
                    message:
                        "عنوان آگهی الزامی است"
                });
            }

            // ===========================
            // دریافت اطلاعات کاربر از DB
            // ===========================

            const userResult =
                await pool.query(
                    `SELECT
                        id,
                        phone,
                        name,
                        family_name,
                        email
                     FROM users
                     WHERE id = $1`,
                    [req.user.userId]
                );

            if (
                userResult.rows.length === 0
            ) {

                return res.status(401).json({
                    success: false,
                    message:
                        "حساب کاربری پیدا نشد"
                });
            }

            const currentUser =
                userResult.rows[0];

            // ===========================
            // پردازش تصاویر
            // ===========================

            let safeImages = [];

            if (Array.isArray(images)) {

                // حداکثر ۸ تصویر
                if (images.length > 8) {

                    return res.status(400).json({
                        success: false,
                        message:
                            "حداکثر ۸ تصویر مجاز است"
                    });
                }

                for (
                    const image of images
                ) {

                    if (
                        typeof image !==
                        "string"
                    ) {
                        continue;
                    }

                    // فقط تصاویر Base64
                    if (
                        !image.startsWith(
                            "data:image/"
                        )
                    ) {
                        continue;
                    }

                    // محدودیت تقریبی 5MB برای هر تصویر
                    if (
                        image.length >
                        7 * 1024 * 1024
                    ) {

                        return res.status(400).json({
                            success: false,
                            message:
                                "حجم یکی از تصاویر بیش از حد مجاز است"
                        });
                    }

                    safeImages.push(image);
                }
            }

            // ===========================
            // پردازش قیمت
            // ===========================

            let safePrice = 0;

            if (
                price !== undefined &&
                price !== null &&
                price !== ""
            ) {

                const normalizedPrice =
                    String(price)
                        .replace(
                            /[۰-۹]/g,
                            d =>
                                "۰۱۲۳۴۵۶۷۸۹"
                                    .indexOf(d)
                        )
                        .replace(
                            /[٠-٩]/g,
                            d =>
                                "٠١٢٣٤٥٦٧٨٩"
                                    .indexOf(d)
                        )
                        .replace(
                            /[,٬\s]/g,
                            ""
                        );

                const numericPrice =
                    Number(normalizedPrice);

                if (
                    !Number.isFinite(
                        numericPrice
                    ) ||
                    numericPrice < 0
                ) {

                    return res.status(400).json({
                        success: false,
                        message:
                            "قیمت وارد شده معتبر نیست"
                    });
                }

                safePrice =
                    numericPrice;
            }

            // ===========================
            // نام فروشنده
            // ===========================

            const safeSellerName =
                sellerName &&
                    String(sellerName).trim()
                    ? String(
                        sellerName
                    ).trim()
                    : (
                        currentUser.name
                            ? currentUser.name
                            : null
                    );

            // ===========================
            // ایمیل فروشنده
            // ===========================

            const safeSellerEmail =
                sellerEmail &&
                    String(sellerEmail).trim()
                    ? String(
                        sellerEmail
                    ).trim()
                    : (
                        currentUser.email
                            ? currentUser.email
                            : null
                    );

            // ===========================
            // شماره فروشنده
            // ===========================
            // مهم:
            // شماره از JWT/DB گرفته می‌شود
            // نه از اطلاعات ارسالی مرورگر.
            //
            // بنابراین کاربر نمی‌تواند
            // شماره حساب شخص دیگری را جعل کند.
            // ===========================

            const safeSellerPhone =
                currentUser.phone;

            // ===========================
            // ثبت واقعی در PostgreSQL
            // ===========================

            const result =
                await pool.query(
                    `INSERT INTO ads (
                        user_id,
                        category,
                        subcategory,
                        title,
                        description,
                        condition,
                        price,
                        region,
                        village,
                        location,
                        seller_name,
                        seller_phone,
                        seller_email,
                        status,
                        images
                    )
                    VALUES (
                        $1,
                        $2,
                        $3,
                        $4,
                        $5,
                        $6,
                        $7,
                        $8,
                        $9,
                        $10,
                        $11,
                        $12,
                        $13,
                        $14,
                        $15::jsonb
                    )
                    RETURNING *`,
                    [
                        req.user.userId,

                        String(
                            category
                        ).trim(),

                        subcategory
                            ? String(
                                subcategory
                            ).trim()
                            : null,

                        String(
                            title
                        ).trim(),

                        description
                            ? String(
                                description
                            ).trim()
                            : null,

                        condition
                            ? String(
                                condition
                            ).trim()
                            : null,

                        safePrice,

                        region
                            ? String(
                                region
                            ).trim()
                            : "کوهمره سرخی",

                        village
                            ? String(
                                village
                            ).trim()
                            : null,

                        location
                            ? String(
                                location
                            ).trim()
                            : null,

                        safeSellerName,

                        safeSellerPhone,

                        safeSellerEmail,

                        "pending",

                        JSON.stringify(
                            safeImages
                        )
                    ]
                );

            // ===========================
            // پاسخ موفق
            // ===========================

            res.status(201).json({
                success: true,
                message:
                    "آگهی با موفقیت در PostgreSQL ذخیره شد",

                ad: result.rows[0],

                imageCount:
                    safeImages.length
            });

        } catch (error) {

            console.error(
                "================================"
            );

            console.error(
                "Create ad error:"
            );

            console.error(error);

            console.error(
                "================================"
            );

            res.status(500).json({
                success: false,
                message:
                    "خطا در ثبت آگهی در PostgreSQL"
            });
        }
    }
);

// ===============================
// دریافت یک آگهی عمومی
// ===============================

app.get(
    "/api/ads/:id",
    async (req, res) => {

        try {

            const id =
                Number(req.params.id);

            if (
                !Number.isInteger(id) ||
                id <= 0
            ) {

                return res.status(400).json({
                    success: false,
                    message:
                        "شناسه آگهی نامعتبر است"
                });
            }

            const result =
                await pool.query(
                    `SELECT *
                     FROM ads
                     WHERE id = $1`,
                    [id]
                );

            if (
                result.rows.length === 0
            ) {

                return res.status(404).json({
                    success: false,
                    message:
                        "آگهی پیدا نشد"
                });
            }

            res.json({
                success: true,
                ad: result.rows[0]
            });

        } catch (error) {

            console.error(
                "Get ad error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "خطا در دریافت آگهی"
            });
        }
    }
);

// ===============================
// دریافت آگهی‌های عمومی
// ===============================

app.get(
    "/api/ads",
    async (req, res) => {

        try {

            const result =
                await pool.query(
                    `SELECT *
                     FROM ads
                     WHERE status = 'approved'
                     ORDER BY created_at DESC`
                );

            res.json({
                success: true,
                ads: result.rows
            });

        } catch (error) {

            console.error(
                "Get ads error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "خطا در دریافت آگهی‌ها"
            });
        }
    }
);

// ===============================
// فایل‌های Frontend
// ===============================

app.use(
    express.static("public")
);

// ===============================
// مدیریت خطای JSON
// ===============================

app.use(
    (error, req, res, next) => {

        if (
            error instanceof SyntaxError &&
            error.status === 400 &&
            "body" in error
        ) {

            return res.status(400).json({
                success: false,
                message:
                    "اطلاعات ارسال شده معتبر نیست"
            });
        }

        if (
            error &&
            error.type ===
            "entity.too.large"
        ) {

            return res.status(413).json({
                success: false,
                message:
                    "حجم اطلاعات یا تصاویر بیش از حد مجاز است"
            });
        }

        next(error);
    }
);

// ===============================
// شروع سرور
// ===============================

app.listen(
    PORT,
    () => {

        console.log("");
        console.log(
            "================================"
        );

        console.log(
            "دیوار کوهمره سرخی"
        );

        console.log(
            "Backend Started"
        );

        console.log(
            `http://localhost:${PORT}`
        );

        console.log(
            `Database: ${process.env.DB_NAME}`
        );

        console.log(
            "PostgreSQL: Connected Pool"
        );

        console.log(
            "================================"
        );

        console.log("");
    }
);
