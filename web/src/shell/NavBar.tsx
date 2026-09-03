import { NavLink } from 'react-router-dom';
import { NAV_ITEMS } from './navItems';
import { cn } from '@/lib/utils';

const itemClass =
  'mb-0.5 flex items-center justify-between rounded-[10px] px-3.5 py-2 text-[13px] text-dim';

/** 左侧导航（8 项，未上线页面置灰标 wave 标签） */
export function NavBar() {
  return (
    <nav data-region="nav" className="w-52 shrink-0 border-r border-line px-2.5 py-3">
      <ul className="m-0 list-none p-0">
        {NAV_ITEMS.map((item) => (
          <li key={item.path}>
            {item.enabled ? (
              <NavLink
                to={item.path}
                className={({ isActive }) =>
                  cn(
                    itemClass,
                    isActive &&
                      'border-l-[3px] border-acc1 bg-gradient-to-r from-acc1/20 to-acc2/15 text-white',
                  )
                }
              >
                {item.label}
              </NavLink>
            ) : (
              <span className={cn(itemClass, 'cursor-not-allowed opacity-40')}>
                <span>{item.label}</span>
                {item.wave && <em className="text-[11px] not-italic">{item.wave}</em>}
              </span>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}
