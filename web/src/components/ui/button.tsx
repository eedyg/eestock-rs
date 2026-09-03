import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

// shadcn 约定（components.json）下的最小 Button；视觉 token 见 index.css
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-lg text-xs transition-colors disabled:pointer-events-none disabled:opacity-40',
  {
    variants: {
      variant: {
        ghost: 'border border-line text-dim hover:text-txt hover:bg-white/5',
        primary:
          'border border-transparent bg-gradient-to-br from-acc1 to-acc2 text-white shadow-[0_2px_10px_rgba(56,189,248,.35)]',
      },
      size: {
        sm: 'h-7 px-3',
      },
    },
    defaultVariants: { variant: 'ghost', size: 'sm' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
  },
);
Button.displayName = 'Button';
