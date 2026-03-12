import React from "react";

interface AnimatedBadgeProps {
  children: React.ReactNode;
  variant?: "success" | "warning" | "error" | "info" | "default";
  pulse?: boolean;
}

export const AnimatedBadge: React.FC<AnimatedBadgeProps> = ({
  children,
  variant = "default",
  pulse = false,
}) => {
  const variants = {
    success: "bg-emerald-50 text-emerald-700 border-emerald-200",
    warning: "bg-amber-50 text-amber-700 border-amber-200",
    error: "bg-red-50 text-red-700 border-red-200",
    info: "bg-blue-50 text-blue-700 border-blue-200",
    default: "bg-gray-100 text-gray-600 border-gray-200",
  };

  return (
    <span
      className={`
        inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border
        transition-all duration-200
        ${variants[variant]}
        ${pulse ? "animate-pulse" : ""}
      `}
    >
      {pulse && (
        <span className="relative flex h-2 w-2">
          <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${variant === "success" ? "bg-emerald-400" : variant === "error" ? "bg-red-400" : variant === "warning" ? "bg-amber-400" : "bg-gray-400"}`}></span>
          <span className={`relative inline-flex rounded-full h-2 w-2 ${variant === "success" ? "bg-emerald-500" : variant === "error" ? "bg-red-500" : variant === "warning" ? "bg-amber-500" : "bg-gray-500"}`}></span>
        </span>
      )}
      {children}
    </span>
  );
};
