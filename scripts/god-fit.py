"""Fit GOD's learned evaluation: logistic regression of the match result on phaseFeatures.

Usage: python3 scripts/god-fit.py /tmp/godd/*.csv
Rows: label, game, size, players, turn, f0..f19 (f0 = bias). Games are split 80/20 by game id for the
held-out log-loss / accuracy; the printed weight vector (f0..f19) is pasted into src/ai/godSim.ts.
"""
import sys
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import log_loss, roc_auc_score

rows = []
for path in sys.argv[1:]:
    with open(path) as fh:
        for line in fh:
            p = line.strip().split(',')
            if len(p) < 6:
                continue
            rows.append([float(p[0]), float(p[1]), float(p[3]), float(p[4])] + [float(x) for x in p[5:]])
a = np.array(rows)
y = a[:, 0]
game = a[:, 1]
X = a[:, 5:]  # skip f0 (bias): sklearn fits the intercept
test = (game % 5) == 0
clf = LogisticRegression(C=float(__import__('os').environ.get('C', '1.0')), max_iter=5000)
clf.fit(X[~test], y[~test])
pt = clf.predict_proba(X[test])[:, 1]
print(f'rows {len(y)} test {test.sum()}  logloss {log_loss(y[test], pt):.4f}  auc {roc_auc_score(y[test], pt):.4f}  acc {((pt > 0.5) == y[test]).mean():.4f}')
# baseline: Master's ratio 2*cells/units mapped like evalPhase
cm = X[:, 2]; uo = X[:, 5]
w = np.concatenate([[clf.intercept_[0]], clf.coef_[0]])
print('weights', '[' + ', '.join(f'{v:.4f}' for v in w) + ']')
# baseline predictor: Master's ratio 2*cells_me / units_opp
ratio = 2 * X[:, 2] / np.maximum(1e-6, X[:, 5] * 8)
print(f'master-ratio auc {roc_auc_score(y[test], ratio[test]):.4f}')
