import type { ComponentPropsWithoutRef } from 'react';
import styles from './OperationsSurface.module.css';

/** Readable, touch-friendly containment for the operations screens only. */
export default function OperationsSurface({ className = '', ...props }: ComponentPropsWithoutRef<'div'>) {
  return <div {...props} className={`${styles.surface} ${className}`} />;
}
