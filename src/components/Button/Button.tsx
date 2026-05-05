import React from 'react';
import { motion, type HTMLMotionProps } from 'framer-motion';
import styles from './Button.module.css';
import { Tooltip } from '../Tooltip/Tooltip';

interface ButtonProps extends Omit<HTMLMotionProps<"button">, 'ref'> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  icon?: React.ReactNode;
  loading?: boolean;
  tooltip?: React.ReactNode;
  tooltipPosition?: 'top' | 'bottom' | 'left' | 'right';
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({
    children,
    variant = 'primary',
    size = 'md',
    icon,
    loading,
    className = '',
    disabled,
    tooltip,
    tooltipPosition = 'top',
    ...props
  }, ref) => {
    const button = (
      <motion.button
        ref={ref}
        whileHover={disabled || loading ? {} : { scale: 1.02 }}
        whileTap={disabled || loading ? {} : { scale: 0.98 }}
        className={`${styles.button} ${styles[variant]} ${styles[size]} ${className}`}
        disabled={disabled || loading}
        {...props}
      >
        {loading ? (
          <div className={styles.spinner} />
        ) : icon ? (
          <span className={styles.iconWrapper}>{icon}</span>
        ) : null}
        {children as React.ReactNode}
      </motion.button>
    );

    if (!tooltip) {
      return button;
    }

    return (
      <Tooltip content={tooltip} position={tooltipPosition} disabled={disabled || loading}>
        {button}
      </Tooltip>
    );
  }
);

Button.displayName = 'Button';
