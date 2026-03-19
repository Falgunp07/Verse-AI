export const auth = async (req, res, next) => {
    try {
        const authData = req.auth();
        const { userId, has, sessionClaims } = authData;

        if (!userId) {
            return res.status(401).json({ success: false, message: "Unauthorized" });
        }

        const hasPremiumPlan = has ? await has({ plan: "premium" }) : false;
        const freeUsageFromClaims = Number(sessionClaims?.metadata?.free_usage ?? 0);

        req.free_usage = Number.isNaN(freeUsageFromClaims) ? 0 : freeUsageFromClaims;
        req.plan = hasPremiumPlan ? "premium" : "free";
        next();
    } catch (error) {
        const status = error?.status || 500;
        res.status(status).json({ success: false, message: error?.message || "Authentication failed" });
    }
}
