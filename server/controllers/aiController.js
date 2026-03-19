import OpenAI from "openai";
import sql from "../configs/db.js";
import { clerkClient } from "@clerk/express";
import axios from "axios";
import { v2 as cloudinary } from "cloudinary";
import fs from "fs";
import  pdf  from "pdf-parse";

// const { default: pdf } = await import("pdf-parse");



const AI = new OpenAI({
    apiKey: process.env.GEMINI_API_KEY?.trim(),
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/"
});
const AI_MODEL = process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";
const AI_MODELS = [
    ...new Set(
        [
            AI_MODEL,
            "gemini-2.5-flash",
            "gemini-1.5-flash",
        ].filter(Boolean)
    ),
];

const pickProviderErrorMessage = (error) => {
    return (
        error?.error?.message ||
        error?.response?.data?.error?.message ||
        error?.response?.data?.message ||
        error?.message
    );
};

const getAiErrorMessage = (error) => {
    const providerMessage = pickProviderErrorMessage(error);

    if (error?.status === 429) {
        return providerMessage
            ? `AI rate limit/quota reached: ${providerMessage}`
            : "AI quota/rate limit reached. Please try again in a minute or update your API quota.";
    }
    return providerMessage || "Something went wrong while generating AI content.";
};

const incrementFreeUsageSafely = async (userId, free_usage) => {
    try {
        await clerkClient.users.updateUserMetadata(userId, {
            privateMetadata: {
                free_usage: free_usage + 1
            }
        });
    } catch (error) {
        console.log("Failed to update free usage metadata:", error?.message);
    }
};

const createCompletionWithFallback = async ({ messages, temperature, max_tokens }) => {
    let lastError;

    for (const model of AI_MODELS) {
        try {
            const response = await AI.chat.completions.create({
                model,
                messages,
                temperature,
                max_tokens,
            });

            return response;
        } catch (error) {
            lastError = error;
            console.log(`Model ${model} failed:`, {
                status: error?.status,
                message: pickProviderErrorMessage(error),
            });

            const retryable = error?.status === 429 || error?.status === 503;
            if (!retryable) {
                throw error;
            }
        }
    }

    throw lastError;
};

export const generateArticle = async (req, res) => {
    try {
        const { userId } = req.auth();
        const { prompt, length } = req.body;
        const plan = req.plan;
        const free_usage = req.free_usage;

        if (plan !== 'premium' && free_usage >= 10) {
            return res.json({ success: false, message: 'Limit reached. Upgrade to continue.' })

        }

        const response = await createCompletionWithFallback({
            messages: [{
                role: "user",
                content: prompt,
            }],
            temperature: 0.7,
            max_tokens: length,
        });
        

        const content = response.choices[0].message.content

        await sql`INSERT INTO creations (user_id,prompt, content, type)
        VALUES (${userId}, ${prompt}, ${content}, 'article')`;

        if (plan !== 'premium') {
            await incrementFreeUsageSafely(userId, free_usage);
        }
        res.json({ success: true, content })

    } catch (error) {
        console.log("generateArticle error:", {
            status: error?.status,
            message: pickProviderErrorMessage(error),
        });
        res.json({ success: false, message: getAiErrorMessage(error) })

    }
}

export const generateBlogTitle = async (req, res) => {
    try {
        const { userId } = req.auth();
        const { prompt } = req.body;
        const plan = req.plan;
        const free_usage = req.free_usage;

        if (plan !== 'premium' && free_usage >= 10) {
            return res.json({ success: false, message: 'Limit reached. Upgrade to continue.' })

        }

        const response = await createCompletionWithFallback({
            messages: [{ role: "user", content: prompt }],
            temperature: 0.7,
            max_tokens: 100,
        });

        const content = response.choices[0].message.content

        await sql` INSERT INTO creations (user_id, prompt, content, type)
        VALUES (${userId}, ${prompt}, ${content}, 'blog-title')`;

        if (plan !== 'premium') {
            await incrementFreeUsageSafely(userId, free_usage);
        }
        res.json({ success: true, content })

    } catch (error) {
        console.log("generateBlogTitle error:", {
            status: error?.status,
            message: pickProviderErrorMessage(error),
        });
        res.json({ success: false, message: getAiErrorMessage(error) })

    }
}

export const generateImage = async (req, res) => {
    try {
        const { userId } = req.auth();
        const { prompt, publish } = req.body;
        const plan = req.plan;

        if (plan !== 'premium') {
            return res.json({ success: false, message: 'This feature is only available for premium subscriptions.' })
        }

        const formData = new FormData()
        formData.append('prompt', prompt)

        const { data } = await axios.post('https://clipdrop-api.co/text-to-image/v1', formData, {
            headers: { 'x-api-key': process.env.CLIPDROP_API_KEY, },
            responseType: "arraybuffer",
        })

        const base64Image = `data:image/png;base64,${Buffer.from(data, 'binary').toString('base64')}`;

        const { secure_url } = await cloudinary.uploader.upload(base64Image)

        await sql` INSERT INTO creations (user_id,prompt, content, type, publish)
        VALUES (${userId}, ${prompt}, ${secure_url}, 'image',${publish ?? false})`;

        res.json({ success: true, content: secure_url })

    } catch (error) {
        console.log("generateImage error:", {
            status: error?.status,
            message: pickProviderErrorMessage(error),
        });
        res.json({ success: false, message: error.message })

    }
}

export const removeImageBackground = async (req, res) => {
    try {
        const { userId } = req.auth();
        const  image = req.file;
        const plan = req.plan;

        if (plan !== 'premium') {
            return res.json({ success: false, message: 'This feature is only available for premium subscriptions.' })
        }

        const { secure_url } = await cloudinary.uploader.upload(image.path, {
            transformation: [
                {
                    effect: 'background_removal',
                    background_removal: 'remove_the_background'
                }
            ]
        })

        await sql` INSERT INTO creations (user_id,prompt, content, type)
        VALUES (${userId}, 'Remove background from image', ${secure_url}, 'image')`;

        res.json({ success: true, content: secure_url })

    } catch (error) {
        console.log("removeImageBackground error:", {
            status: error?.status,
            message: pickProviderErrorMessage(error),
        });
        res.json({ success: false, message: getAiErrorMessage(error) })
    }
}

export const removeImageObject = async (req, res) => {
    try {
        const { userId } = req.auth();
        const { object } = req.body;
        const  image  = req.file;
        const plan = req.plan;

        if (plan !== 'premium') {
            return res.json({ success: false, message: 'This feature is only available for premium subscriptions.' })
        }

        const { public_id } = await cloudinary.uploader.upload(image.path)

        const imageUrl = cloudinary.url(public_id, {
            transformation: [{ effect: `gen_remove:${object}` }],
            resource_type: 'image'
        })

        await sql` INSERT INTO creations (user_id,prompt, content, type)
        VALUES (${userId}, ${`Removed ${object} from image`}, ${imageUrl}, 'image')`;

        res.json({ success: true, content: imageUrl })

    } catch (error) {
        console.log("removeImageObject error:", {
            status: error?.status,
            message: pickProviderErrorMessage(error),
        });
        res.json({ success: false, message: error.message })
    }
}

export const resumeReview = async (req, res) => {
    try {
        const { userId } = req.auth();
        const resume = req.file;
        const plan = req.plan;

        if (plan !== 'premium') {
            return res.json({ success: false, message: 'This feature is only available for premium subscriptions.' })
        }

        if(resume.size > 5* 1024 * 1024){
            return res.json({success: false, message:"Resume file size exceeds allowed size (5MB."})
        }

        const dataBuffer = fs.readFileSync(resume.path)
        const pdfData = await pdf(dataBuffer)

        const prompt = `Review the following resume and provide constructive feedback on its strengths , weakness and areas for improvment. Resume Content:\n\n${pdfData.text}`

        const response = await createCompletionWithFallback({
            messages: [{ role: "user", content: prompt }],
            temperature: 0.7,
            max_tokens: 1000,
        });

        const content = response.choices[0].message.content

        await sql` INSERT INTO creations (user_id,prompt, content, type)
        VALUES (${userId}, 'Review the uploaded resume', ${content}, 'resume-review')`;

        res.json({ success: true, content})

    } catch (error) {
        console.log("resumeReview error:", {
            status: error?.status,
            message: pickProviderErrorMessage(error),
        });
        res.json({ success: false, message: getAiErrorMessage(error) })
    }
}
